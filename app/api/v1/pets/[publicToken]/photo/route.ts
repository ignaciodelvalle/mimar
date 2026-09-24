// `/api/v1/pets/{publicToken}/photo` — the pet's photo, from a phone.
//
// THIS IS THE ROOT BLOCKER'S DOOR, AND IT IS NOT A SIGNED URL INTO pet-photos
// ---------------------------------------------------------------------------
// The native client has never been able to upload anything: `client.ts` speaks
// JSON and nothing else, and `mascotas/index.tsx` has carried a written note
// since M4 saying the placeholder is there because photo upload is a later work
// unit. This is that unit for the pet photo — the one a real owner notices
// first, because a credential with no photo looks broken before it looks
// incomplete.
//
// The brief for it said "signed uploads", and the repo's own architecture note
// refuses the obvious reading. docs/architecture/api-invariants.md §1.5, on
// `lib/infra/uploads.ts`'s three security properties:
//
//     "native uploading direct-to-storage with a signed URL loses all three at
//      once. No createSignedUploadUrl exists anywhere today — every signed URL
//      in the repo is a download. Keep it that way, or replicate all three
//      server-side first."
//
// So the ticket points at a PRIVATE staging bucket (migration 0206) and a
// second, re-authorized command validates the bytes before anything believes
// they are a photo. `lib/infra/pet-photo-upload.ts` holds that machinery and
// the argument for it; this file is the door.
//
// ONE URL, TWO COMMANDS, for the reason `/lost` has one URL and six: two
// sibling routes would be two copies of one bearer check, one limiter pair and
// one access guard, kept in agreement by hand. It also means ONE per-IP bucket,
// spent twice per photo — `API_V1_MEDIA_UPLOAD_USER_LIMIT` says why the anchor
// is sized per REQUEST because of it.
//
// WHO MAY CHANGE A PET'S PHOTO, AND WHY IT IS NOT THE TITULAR GATE
// ---------------------------------------------------------------------------
// The web's photo field lives inside `updatePetAction`, which is behind
// `requireTitularAccess`. Copying that here would have been the easy move and
// it would have been WRONG, because the titular gate on that action is about
// the OTHER fields in the same form:
//
//   · `lib/domain/titular-only.ts` — the single declaration of what a caretaker
//     may not do — opens by listing what a caretaker MAY: "medical events,
//     notes, PHOTOS, lost/found — yes".
//   · `TITULAR_ONLY_PET_COLUMNS` in that same file names `name`, `species`,
//     `breed`, the jurisdiction columns, the adoption columns and the Tier-2
//     columns. `primaryPhotoId` is deliberately not among them, so the fence
//     `scripts/check-titular-gate.ts` does not consider this write titular-only
//     either.
//
// A caretaker photographing the animal in their care is the case the caretaker
// role exists for. So the person path takes any holder role, exactly like the
// event door.
//
// THE ORG PATH IS CAPABILITY-GATED, and that is a decision rather than a copy.
// `requireTitularAccess` checks no capability, so the web currently lets any
// member of a custodian organización change a pet's photo. This door demands
// `event.write` — the same capability `requireAlivePetAccess` demands for the
// other org-path media write in the product, an attachment on an event. Media
// about an animal somebody else owns is the same act whichever row it hangs
// off, and the tighter of the two existing answers is the right one to land a
// NEW door on. The looser web path is named here rather than quietly matched;
// closing it is its own change.
//
// NO `Idempotency-Key`, AND IT IS A REFUSAL TO PROMISE RATHER THAN AN OMISSION.
// A photo is a VALUE, not an append: `confirm` sets `primary_photo_id`, and
// setting it twice is setting it once. `request_ticket` mints a fresh key each
// time, so a retry stages a second blob and abandons the first — an orphan,
// bounded by this route's own rate limit and named as a residual in migration
// 0206. Neither command has a duplicate to suppress, and
// demanding a header for a guarantee that is already unconditional is the false
// promise `writers.ts` refuses to make for atestación PPP.
//
// A DEAD PET IS NOT REFUSED. `requireAlivePetAccess` blocks new EVENTS on a
// deceased animal because the spine should not grow after the fact; a photo is
// not an event and the web's own photo path carries no such check. An owner
// adding the last good picture of an animal that died is not a thing to refuse.

import { apiV1Error } from "@/lib/infra/api-v1";
import {
  API_V1_MEDIA_UPLOAD_IP_LIMIT,
  API_V1_MEDIA_UPLOAD_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { petPhotoCommandInputSchema } from "@dim/contract/input";

import { runPhotoCommand } from "./commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query — indexed, single row. Plus the org capability read. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The command's own budget, and it is the widest on this surface for a reason no
 * other endpoint has: the expensive command is not waiting on Postgres.
 * `confirm` downloads up to 5 MB out of Storage, runs it through sharp, and
 * writes the result back. Twenty seconds is a slow pooler AND a slow object
 * store AND a big JPEG, and below the platform's own function ceiling.
 *
 * ONE NUMBER FOR BOTH COMMANDS, and it is generous for `request_ticket` (one
 * signature, one round trip). A second constant would be a knob nobody needs:
 * the ceiling exists so a stuck dependency becomes a retryable 503 instead of a
 * spinner, and that is the same requirement at either end.
 */
const COMMAND_BUDGET_MS = 20_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

// AUTHORIZED, not opted out: the handler calls requireLiveUser and then resolves
// pet access, and those two calls ARE the authorization. Said here for a reader
// scanning for the guard — and said WITHOUT writing the opt-out marker, because
// a comment that spells the marker in order to deny it still reads as one to a
// scanner matching the token.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_pet_photo_ip",
      callerIp(request.headers),
      API_V1_MEDIA_UPLOAD_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT — and that is the right rule
  // rather than a limitation: a reader auditing who may reach this URL should
  // find the answer here.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pet-photo-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (!(await spendBudget("api_v1_pet_photo_user", live.user.id, API_V1_MEDIA_UPLOAD_USER_LIMIT))) {
    return apiV1Error("rate_limited", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally. This is the backstop for a client out of step with the contract,
  // which is why it carries no field detail — the envelope is one key.
  const parsed = petPhotoCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // THE AUTHORIZATION, both halves, in ONE try. The org-path capability read is
  // part of the same question as the access resolution — "may this caller change
  // this animal's photo" — and a `DbBudgetExceededError` from either is the same
  // 503. Two try blocks would be two copies of that mapping.
  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  let orgMayWriteMedia = true;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-pet-photo-access",
    );
    // The org path needs the capability; the person path needs nothing more (see
    // the header for why the titular gate is the WRONG gate here).
    if (access.kind === "org") {
      const granted = await withDbBudgetOrThrow(
        getGrantedCapabilities(access.membership),
        ACCESS_BUDGET_MS,
        "api-v1-pet-photo-capability",
      );
      orgMayWriteMedia = granted.has("event.write");
    }
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  //
  // AN ERASED ANIMAL IS ONE OF THOSE. `resolvePetHolderAccess` now filters
  // `pets.deleted_at` on both of its paths (closed 2026-08-28), so an erased
  // pet already resolves `kind: "none"` above. The explicit check below is
  // belt-and-braces against a resolver regression — this door mints a
  // capability, and it was the first surface to catch the class when the
  // resolver still had the gap (`__tests__/public-soft-delete-resolution
  // .test.ts` flagged it). `confirmPetPhoto` repeats the check inside its
  // transaction regardless, because the erasure can land in the two hours
  // between the two calls.
  if (access.kind === "none" || (access.pet as { deletedAt: Date | null }).deletedAt !== null) {
    return apiV1Error("not_found", 404);
  }
  if (!orgMayWriteMedia) return apiV1Error("photo_forbidden", 403);

  try {
    return await withDbBudgetOrThrow(
      runPhotoCommand({
        petId: (access.pet as { id: string }).id,
        userId: live.user.id,
        input: parsed.data,
      }),
      COMMAND_BUDGET_MS,
      "api-v1-pet-photo-command",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop an owner adding a photo over an abuse
 * control, while the authorization boundary stays intact and fails CLOSED.
 */
async function spendBudget(
  endpoint: string,
  identifier: string,
  limit: { maxPerMinute?: number; maxPerHour?: number; maxPerDay?: number },
): Promise<boolean> {
  try {
    await enforceRateLimit(endpoint, identifier, limit);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    reportError(`api-v1-pet-photo/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 */
function liveUserRefusal(reason: LiveUserFailureReason) {
  switch (reason) {
    case "NO_SESSION":
      return apiV1Error("auth_expired", 401);
    case "ACCOUNT_ERASED":
      return apiV1Error("account_erased", 403);
    case "DEACTIVATED":
      return apiV1Error("account_deactivated", 403);
    case "SHIFT_EXPIRED":
      return apiV1Error("session_shift_expired", 401);
    case "MAINTENANCE":
      return unavailable();
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
