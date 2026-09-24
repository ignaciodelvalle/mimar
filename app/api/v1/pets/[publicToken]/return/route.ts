// `/api/v1/pets/{publicToken}/return` — DEVOLUCIÓN: an animal going back.
//
// GET reads what the screen needs — the animal's name, what is going on with its
// return right now, and which of the three commands this caller may send. POST
// runs one of them: aceptar, rechazar, or proponer la devolución.
//
// WHY THERE IS A READ HERE AT ALL, when the mudanza door beside it has none
// ---------------------------------------------------------------------------
// Because a phone holding the whole pet payload still cannot work out what it
// may do. The three writers behind this feature disagree about whom they serve,
// and none of the disagreements is on the wire anywhere else: accepting needs a
// pending proposal ADDRESSED to the caller, proposing needs an organisation
// derived from an `adoption_finalized` payload or an open custody row. A client
// deriving either would be keeping a second copy of an authorization rule on the
// act that hands an animal back.
//
// AND THE READ AND THE WRITE SHARE ONE DERIVATION. `./payload.ts`'s
// `petReturnCapabilities` is called by both, so a screen can never be offered a
// control this endpoint refuses — the arrangement `pets/{token}/profile` uses,
// for the same stated reason.
//
// THE PERSON PATH ONLY. `resolvePetHolderAccess` answers `kind: "org"` for a
// member of an organisation that holds this animal, and this door 404s that
// caller exactly as the web's page does: `/mis-mascotas/{token}/devolucion`
// resolves access with `eq(ownerships.ownerUserId, user.id)` and `notFound()`s
// anything else. The organisation's side of a return is `custody.transfer`
// behind `/org/{token}`, and this app has no organisation surfaces at all.
//
// TWO FAMILIES, ONE FILE — numbers and derivations in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// THE READ takes the authenticated-read family, on the argument every pet-scoped
// read on this surface makes: a client that opens a pet and taps "Devolución"
// calls `/pets/{token}` and this inside one second, so a tighter ceiling here
// would punish an ordinary sequence.
//
// THE WRITE takes the GENERIC authenticated-write family, and the neighbouring
// choice is `/me/transfers` — which is not a neighbour, it is the SAME ACT. That
// route's ceiling is derived against "a change of who owns an animal in the
// national registry", and `accept_return` is precisely that: it ends the actor's
// custody row, appends `custody_transferred`, moves `pets.status` and closes two
// cases. Ten a minute per person is that family's own words — "generous headroom
// for a person answering a backlog of proposals plus every retry a flaky
// connection produces" — and answering return proposals is literally what it
// describes.
//
// THE WEB HAS NO LIMITER ON ANY OF THE THREE — all are bare server actions
// behind `requireUserOrRedirect` — so this door is strictly tighter than the
// browser for the same acts. Tighter is the safe direction and the gap is the
// WEB'S; closing it means editing actions the browser also uses.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { readPetReturnState } from "@/src/modules/return-to-owner/application/read-return-state";
import { petReturnCommandInputSchema } from "@dim/contract/input";

import { runPetReturnCommand, unavailable } from "./commands";
import { buildPetReturnV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query, and then the state resolution's four indexed reads. */
const ACCESS_BUDGET_MS = 5_000;
const STATE_BUDGET_MS = 8_000;

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
      "api_v1_return_read_ip",
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
      "api-v1-return-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_return_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-return-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read, a pet that does not exist, and a pet held
  // through an ORGANISATION membership all answer IDENTICALLY. The first two are
  // PO-4; the third is the web's page, which resolves access by `ownerUserId`
  // alone and `notFound()`s an org member.
  if (access.kind !== "owner") return apiV1Error("not_found", 404);

  let state: Awaited<ReturnType<typeof readPetReturnState>>;
  try {
    state = await withDbBudgetOrThrow(
      readPetReturnState({
        pet: { id: access.pet.id },
        userId: live.user.id,
        holderRole: access.holderRole,
      }),
      STATE_BUDGET_MS,
      "api-v1-return-state",
    );
  } catch (err) {
    // NOT a silent empty state. A read that failed and an animal with nothing
    // going on are different facts, and a screen saying "no hay devoluciones
    // pendientes" over a pooler outage would tell somebody nobody is trying to
    // give their animal back.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(
    buildPetReturnV1({
      publicToken,
      petName: access.pet.name,
      state,
      now: new Date(),
    }),
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
      "api_v1_return_write_ip",
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
      "api-v1-return-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_return_write_user",
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
  const parsed = petReturnCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-return-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (access.kind !== "owner") return apiV1Error("not_found", 404);

  return runPetReturnCommand({
    publicToken,
    userId: live.user.id,
    pet: { id: access.pet.id, publicToken: access.pet.publicToken },
    holderRole: access.holderRole,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stand between somebody and the animal being handed
 * back to them — while the AUTHORIZATION boundary stays intact and fails CLOSED.
 * That is the one that must, and the pair is asserted against each other in this
 * route's test rather than only described here: a fail-open limiter that carried
 * the guard open with it would be one line doing two jobs.
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
    reportError(`api-v1-return/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` refuses BOTH methods, and it is STRICTER than the web:
 * `requireUserOrRedirect` passes a deactivated account on purpose, so the
 * browser's devolución page serves one. The direction is the safe one — it
 * grants nothing the browser grants — and it is the same divergence
 * `me/pet-claims` recorded, pinned by a test so it stays a decision rather than
 * becoming drift.
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
