// `/api/v1/pets/{publicToken}/profile` — EDITAR: the things about an animal an
// owner changes that are not asientos.
//
// GET reads what a form needs to pre-fill itself — the three identity fields,
// the pet-level emergency-contact override, the account defaults each of those
// falls back to when cleared, and which of the commands this caller may send.
// POST runs one of three: editar los datos, guardar los contactos, or corregir
// la especie (the FULL-LOCK correction, added 2026-09-10 — `./commands.ts`).
//
// WHY THIS IS NOT ON THE EVENTS ENDPOINT, and why it is not two endpoints
// ---------------------------------------------------------------------------
// Everything behind `POST .../events` appends one row and answers with its id.
// Neither command here does that: `edit_identity` UPDATES seventeen columns and
// appends a bundled `pet_profile_updated` describing the diff, and
// `set_emergency_contacts` appends nothing at all — the four override columns
// are UI preferences and their writer says so out loud ("editing them does NOT
// emit a pet event").
//
// They share one URL for the reason compartir's two mechanisms do: a person here
// is doing one thing — correcting what the app says about their animal — and the
// web puts both behind the same "⋯ Más" sheet (`MasSheet.helpers.ts`, rows `edit`
// and `contacts`). Two routes would be two copies of one bearer check, one
// limiter pair and one access guard, kept in agreement by hand.
//
// AND THEY DO NOT SHARE A GUARD, which is the thing to read before touching this
// directory. `./payload.ts` derives the two capabilities once and both the read
// and the write use them; `./commands.ts` states the rules and cites the web
// line that each mirrors. In short: identity is `requireTitularAccess` (every
// holder except a caretaker, org path included), contacts are the LEGAL owner
// alone. A "tidied" single rule would either hand a foster the titular's phone
// numbers or refuse a co-owner a name correction the web allows.
//
// WHAT THIS ENDPOINT DELIBERATELY DOES NOT EDIT — each absent for its own reason,
// all written out in `@dim/contract/api`'s `pet-profile-edit.ts`: species and
// jurisdiction AS FIELDS OF THE IDENTITY EDIT (FULL-LOCK, each with its own
// event-governed correction path — the species' is the `correct_species`
// command on this same URL, the jurisdiction's is `/move`),
// `distinguishing_features` (no profile-edit writer exists anywhere, and it is
// not a field of `diffPet`, so a value written here would never reach the
// spine), and the photo (its own ticket-and-confirm door).

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { readViewerContacts } from "@/src/modules/pets/application/read/owner-pet-detail-queries";
import { petProfileCommandInputSchema } from "@dim/contract/input";

import { runPetProfileCommand, unavailable } from "./commands";
import { buildPetProfileEditV1, petProfileCapabilities } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query and the account-defaults read — both indexed, single row. */
const ACCESS_BUDGET_MS = 5_000;

// TWO FAMILIES, ONE FILE — numbers and derivations in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// THE READ takes the authenticated-read family, on the same argument `/lost`
// makes for its own: a client that opens a pet and taps "Editar datos" calls
// `/pets/{token}` and this inside one second, so a tighter ceiling here would
// punish an ordinary sequence.
//
// THE WRITE takes the GENERIC authenticated-write family, and that is a decision
// rather than a default. `/lost` and `/shares` share `pet-disclosure-write`
// because both change what OTHER PEOPLE may see of an animal; neither command
// here does. An identity correction publishes nothing new — the name was already
// on the public credential — and the contact override is read by nobody but the
// owner. What bounds this act is the ordinary "one person editing their own
// records" budget: 10/min, 40/hr, 100/day per user.
//
// Both keep their OWN bucket names: a shared counter makes "which surface is
// being hammered" unanswerable from the limiter's own storage.

// AUTHORIZED, not opted out: both handlers call requireLiveUser and then resolve
// pet access, and those two calls ARE the authorization. Said here for a reader
// scanning for the guard — and said WITHOUT writing the opt-out marker, because
// a comment that spells the marker in order to deny it still reads as one to a
// scanner matching the token.
export async function GET(
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
      "api_v1_profile_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper the two methods share.
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT —
  // and that is the right rule rather than a limitation: a reader auditing who
  // may reach this URL should find the answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-profile-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_profile_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-profile-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  // THE ACCOUNT DEFAULTS ARE READ ONLY FOR SOMEBODY WHO MAY SEE THEM. They are
  // the CALLER's own vet and emergency contact, and for a caller who cannot edit
  // the pet-level override the payload drops them — so reading them would be a
  // query whose only possible use is to be discarded.
  let accountContacts: Awaited<ReturnType<typeof readViewerContacts>> = null;
  if (petProfileCapabilities(access).canEditEmergencyContacts) {
    try {
      accountContacts = await withDbBudgetOrThrow(
        readViewerContacts(live.user.id),
        ACCESS_BUDGET_MS,
        "api-v1-profile-account-contacts",
      );
    } catch (err) {
      // NOT a silent null. A read that failed and an account with no defaults
      // are different facts, and a form that said "si lo dejás vacío no
      // mostramos nada" over a pooler outage would be lying about what clearing
      // a field does.
      if (err instanceof DbBudgetExceededError) return unavailable();
      throw err;
    }
  }

  return apiV1Json(
    buildPetProfileEditV1({ pet: access.pet, access, accountContacts, now: new Date() }),
    { status: 200 },
  );
}

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
      "api_v1_profile_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body for the same reason the read's copy is — see the note
  // there. Two calls, not one shared helper, because the fence that keeps this
  // URL honest cannot see through a function.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-profile-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_profile_write_user",
      live.user.id,
      API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
    ))
  ) {
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
  const parsed = petProfileCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runPetProfileCommand({
    publicToken,
    userId: live.user.id,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop an owner correcting their animal's name over
 * an abuse control, while the authorization boundary stays intact and fails
 * CLOSED. That is the one that must.
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
    reportError(`api-v1-profile/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` refuses the WRITE and, here, the read too — this whole surface
 * is one URL, and splitting the liveness rule by method would be the endpoint
 * inventing a policy its siblings do not have.
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
