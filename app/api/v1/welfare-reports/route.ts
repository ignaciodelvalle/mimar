// `/api/v1/welfare-reports` — DENUNCIAR MALTRATO, from the phone.
//
// Ley Nacional 14.346 (1954). POST files a citizen denuncia of animal cruelty:
// nine kinds, a location, a description, and a routing to the authority whose
// jurisdiction the coordinates fall in. It is a legal act with consequences for
// a named third party, not a report about a piece of content, and every design
// decision on this door follows from that sentence.
//
// WHY THE URL IS NOT `/me/welfare-reports`, WHICH IS THE OBVIOUS SHAPE
// ---------------------------------------------------------------------------
// Every other authenticated write on this surface hangs off `/me` because the
// thing it writes belongs to the caller. A denuncia may deliberately NOT belong
// to the caller: the whole point of the anonymous mode is that the record
// carries no link to the person who filed it, so `/me/welfare-reports` would be
// a URL whose own path asserts the association the body is refusing to create.
// `me/pet-claims` chose its `/me` prefix for the mirror-image reason ("the URL
// names the CALLER's claims, and the animal is something the server derives"),
// and the same reasoning lands the other way here.
//
// It is a plural collection under `/api/v1` for the same reason `/localities`
// is: the resource is not scoped to an identity.
//
// A BEARER TOKEN IS REQUIRED, AND THE RECORD IS STILL ANONYMOUS
// ---------------------------------------------------------------------------
// This is the one place a reader is owed the whole truth rather than a
// reassurance, because "anonymous" is the axis this endpoint exists on.
//
// The WEB accepts a denuncia from a signed-out browser: no session, no identity
// in flight, `reporter_user_id` null. A `/api/v1` door cannot do that today —
// every handler on this surface opens with `createClientFromBearer` and then
// `requireLiveUser`, the app has no signed-out screen (`app/index.tsx` is a
// gate), and inventing an unauthenticated `/api/v1` write would be inventing a
// second intake with its own abuse surface for a client that has a session
// anyway.
//
// So this door offers the property the RECORD can have and not the one the
// TRANSPORT cannot: `contactMode: "anonymous"` writes `reporter_user_id = null`
// and `cases.opened_by_user_id = null`, and nothing in the response, the log or
// the event spine names the caller. What it does NOT give is unattributability
// in flight — the bearer token identified them to the server before the body was
// read, and a person who needs that has the browser. `commands.ts` says the same
// thing next to the code that implements it, and the screen says it to the
// person in es-AR, because a privacy property a user is wrong about is worse
// than one they do not have.
//
// NO ATTACHMENTS, AND NO PARALLEL PATH TO GET AROUND IT
// ---------------------------------------------------------------------------
// Evidence lands in a private bucket through a signed upload — a picker, a
// native module, an EAS build. This door takes JSON and no bytes at all.
//
// The temptation is a second upload route "just for denuncia photos". Two
// reasons not to, and the second is the sharper one. First, this repo already
// carries two blanket storage grants that exist because somebody built a
// parallel path once. Second: a phone photo carries the GPS EXIF of wherever it
// was taken — frequently an anonymous reporter's own home. The web door handles
// that in `lib/infra/welfare-uploads.ts`: HEIC/HEIF is refused (PO decision D4,
// 2026-09-18) and the JPEG/PNG/WebP strip fails closed. Video still carries its
// position until the D4b neutraliser lands. Anyone adding uploads here must go
// through that helper, not beside it.
//
// THE BUDGETS
// ---------------------------------------------------------------------------
// ONE per-IP bucket for the route, `API_V1_AUTHENTICATED_WRITE_IP_LIMIT`. It
// runs BEFORE the GoTrue round-trip, which is its job: a caller with a
// well-formed but invalid token must not be able to spend `auth.getUser()` calls
// unbounded. The family is the generic authenticated-write one rather than a
// denuncia-specific derivation, because what this bucket sizes is CGNAT
// exposure, and behind a carrier gateway a denuncia is one person filling in a
// long form — the same act `me/profile` and `pets/{token}/profile` are anchored
// on. It is NOT `pet-record-write` (that anchor is "a vet day at a rescue, many
// animals from one egress"), and it is NOT `inbox-state` (whose anchor is one
// indexed UPDATE on the caller's own row; this write opens a case, links it and
// signals an authority).
//
// The per-USER ceiling is deliberately NOT one of this surface's constants: it
// is `welfare_auth`, 10/hr, keyed on the user id — the SAME bucket the browser's
// own action spends. See `commands.ts`.
//
// `api_v1_welfare_reports_ip` IS IN `API_V1_IP_BUCKET_FAMILIES`, and this
// paragraph is the correction of the one that stood here until the 2026-08-30
// integration merge. That version was written when the entry really was absent
// and really was being handed over — `lib/infra/api-v1-limits.ts` was another
// lane's territory when this file was last touched — and it said four things:
// the entry is not in the map, it is handed to the integrator,
// `__tests__/api-v1-rate-limit-families.test.ts` is TWO tests red, and the
// aggregate ceiling pin (11 064) stays green. **All four went false inside this
// lane's own branch**, six commits after this file stopped being edited, and
// nothing turned red to say so: prose is not compiled.
//
// It is corrected rather than deleted because of what it was wrong ABOUT. The
// hand-off it described was real and the ceiling really does under-declare
// itself by 120/min while an entry is missing — that is the reclamar door's
// warning and it still holds. What expired is the tense. A note that tells the
// next reader to apply a line already applied costs somebody an afternoon
// proving it is already there, which is the second time that has happened on
// this surface.
//
// The pin is `toBe`, not a floor, so it is the one number here that cannot rot
// quietly — but this file transcribed it wrong at least three times already
// (11 064, then 12 444, then 12 924, none of which survived the window), so
// the number is named and not repeated here either: read
// `API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE` (`lib/infra/api-v1-limits.ts`)
// and its `toBe` assertion at
// `__tests__/api-v1-rate-limit-families.test.ts:754`.
//
// NO `Idempotency-Key`, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// The writer takes no idempotency key for the denuncia itself — only for the
// pet-event bridge, which this door never reaches. A retry after a timeout
// therefore files a SECOND denuncia with a second reference code. That is not
// silently absorbed and it is not hidden: `computeFlagReasons` catches the pair
// as `duplicate_within_24h` and routes both to moderation, which is a human
// looking at two near-identical reports — the correct outcome for a legal filing
// nobody can retract. A client's move after a timeout is to ask the person, not
// to re-send.

import { apiV1Error } from "@/lib/infra/api-v1";
import { API_V1_AUTHENTICATED_WRITE_IP_LIMIT } from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { welfareReportCommandInputSchema } from "@dim/contract/input";

import { runWelfareReportCommand, unavailable } from "./commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body.
// There is no second authorization step and there is not meant to be one — a
// denuncia is a thing ANY citizen may file about ANY animal, and a door that
// asked "may you act on this pet" would be a door that refuses every legitimate
// denuncia there is. Said here for a reader scanning for the guard, and said
// WITHOUT writing the opt-out marker, because a comment that spells the marker
// in order to deny it still reads as one to a scanner matching the token.
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_welfare_reports_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-authz-guards` reads
  // the handler body ONLY and does not follow calls, so a guard factored into a
  // module-level function reads as ABSENT — and that is the right rule rather
  // than a limitation: a reader auditing who may reach this URL should find the
  // answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-welfare-reports-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally. This is the backstop for a client out of step with the contract,
  // which is why it carries no field detail — the envelope is one key. It is
  // ALSO what makes the anonymous shape's missing contact fields structural on
  // the wire: zod strips what the member does not declare, so a body pairing
  // `contactMode: "anonymous"` with an e-mail address arrives at `commands.ts`
  // with no e-mail address in it.
  const parsed = welfareReportCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runWelfareReportCommand({ userId: live.user.id, input: parsed.data });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface, and here the direction is not a convention but the point: the
 * act being bounded is a person reporting cruelty to an animal, and an abuse
 * control must not be the thing standing between them and an authority. The same
 * argument the art. 16 erasure makes about a legal right.
 *
 * NO AUTHORIZATION BOUNDARY DEPENDS ON THIS. Identity is established by
 * `requireLiveUser` below it, and no failure of this function reaches that.
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
    reportError(`api-v1-welfare-reports/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * DEACTIVATED IS REFUSED HERE AND SERVED ON THE WEB, which is the third time
 * this divergence has had to be written down (`me/privacy`, `me/pet-claims`) and
 * the first time the answer is uncomfortable. `requireUserOrRedirect` passes a
 * deactivated account on purpose, and `/denuncias/nueva` does not require an
 * account at all — so a deactivated person can always file from a browser, and
 * refusing them here costs them nothing except one screen. That is the only
 * reason this is safe to mirror: the act is not gated on the account, so the
 * strictness is a property of the transport rather than a removal of a right. If
 * that ever stops being true — if a denuncia ever requires a session — this arm
 * is the first thing to revisit.
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
