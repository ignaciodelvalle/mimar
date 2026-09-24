// `/api/v1/pets/{publicToken}/move` — MUDANZA: the animal changed jurisdiction.
//
// POST ONLY, AND THE MISSING GET IS A DECISION
// ---------------------------------------------------------------------------
// A form here needs two things and already has both: where the animal lives now
// (`GET /api/v1/pets/{publicToken}` carries it — it is on the credential face)
// and which destinations exist (`GET /api/v1/localities`, the same public
// typeahead the alta form spends). A third read would be a route, a per-IP
// bucket and a payload version bought to re-send two fields the client is
// holding. `@dim/contract/api`'s `pet-move.ts` states it and states what the
// absence costs: there is no `capabilities` block either, so a client must NOT
// derive who may move an animal — it posts and reads the 403.
//
// WHY THIS IS ITS OWN URL AND NOT A THIRD COMMAND ON `…/profile`
// ---------------------------------------------------------------------------
// Because that door refuses jurisdiction in writing, and the refusal is the
// design rather than a gap. `pet-profile-edit.ts` lists species and jurisdiction
// under "WHAT IS NOT HERE, AND WHY EACH ONE IS ABSENT RATHER THAN FORGOTTEN":
// both are FULL-LOCK (PO decision #40), `updatePetProfile` omits the columns
// from its `SET`, and each has "its own event-governed correction path
// (`correctPetSpeciesAction`, `recordMoveAction`). An 'editar' endpoint that
// accepted them would be a second, ungoverned door onto legally load-bearing
// state." The web has three routes for the same reason — `/editar`, `/mudanza`,
// `/corregir-especie` — and this is the second of the three.
//
// The URL says `move` and not `mudanza` for the reason every `/api/v1` segment
// is English while every screen path is Spanish: `apps/mobile/app/mascotas/
// {token}/mudanza.tsx` is the screen, this is the capability, and
// `CAPABILITY_PATH_SEGMENTS` already carries `pets` for the token that follows
// it — the redaction rule keys on the segment BEFORE the token, so a new leaf
// under `pets/[publicToken]/` needs no new entry.
//
// ONE FAMILY, ONE ACT — numbers and derivation in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// The write takes the GENERIC authenticated-write family, and it is the
// neighbouring choice being rejected rather than a default being taken. It is
// NOT `pet-record-write`, even though what it appends IS a row on the spine:
// that family's anchor is "a vet day at a rescue is many animals from one egress
// in one afternoon", and a person moves house. It is NOT
// `pet-disclosure-write` either — a move publishes nothing new; the animal's
// locality was already on the public credential. What bounds this act is the
// ordinary "one person editing their own records" budget, which is the same
// anchor the pet's own editar door runs on and the same act: somebody in a form,
// possibly saving twice because the first tap did not register.
//
// THE WEB HAS NO LIMITER ON THIS AT ALL — `recordMoveAction` is a bare server
// action behind `requireTitularAccess` — so this door is strictly tighter than
// the browser for the same act. Tighter is the safe direction and the gap is the
// WEB'S; closing it means editing an action the browser also uses.

import { apiV1Error } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { petMoveCommandInputSchema } from "@dim/contract/input";

import { runPetMoveCommand, unavailable } from "./commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

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
      "api_v1_move_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT — and that is the right rule
  // rather than a limitation: a reader auditing who may reach this URL should
  // find the answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-move-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_move_write_user",
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
  const parsed = petMoveCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runPetMoveCommand({
    publicToken,
    userId: live.user.id,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop an owner recording where their animal now
 * lives over an abuse control — while the AUTHORIZATION boundary stays intact
 * and fails CLOSED. That is the one that must, and the pair is asserted against
 * each other in this route's test rather than only described here: a fail-open
 * limiter that carried the guard open with it would be one line doing two jobs.
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
    reportError(`api-v1-move/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` refuses, and it is STRICTER than the web: `requireUserOrRedirect`
 * passes a deactivated account on purpose, so the browser's mudanza page serves
 * one. The direction is the safe one — it grants nothing the browser grants —
 * and it is the same divergence `me/pet-claims` recorded, pinned by a test so it
 * stays a decision rather than becoming drift.
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
