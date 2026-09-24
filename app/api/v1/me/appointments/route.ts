// `/api/v1/me/appointments` — TURNOS, for the person who booked them.
//
// GET reads the hub in the web's own three sections: próximos, pasados,
// cancelados. POST runs the one command an owner's browser offers — cancelar.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// Every row here DOES name an animal, so unlike `/me/transfers` this one could
// have been `/pets/{token}/appointments`. It is not, because the question the
// screen answers is not per-pet: somebody opening `/mis-turnos` is asking "what
// do I have booked", across every animal they are responsible for, ordered by
// time. Per-pet would make the phone ask N times to answer it, and would lose the
// ordering that is the point.
//
// It also carries rows for animals the caller does not own. `bookSlotAction`
// accepts any active ownership role, so a foster or a co-owner books under their
// own id; the appointment is theirs even when the animal is not.
//
// THE WRITE THIS DOOR DOES NOT HAVE, AND WHY THAT IS SCOPE AND NOT A DECISION
// ---------------------------------------------------------------------------
// `POST` accepts `cancel` and nothing else. Booking is an owner capability on the
// web and it belongs on this surface eventually; it needs a search and a slot
// picker that do not exist natively yet, so it is a later work unit rather than a
// refusal. The contract's input union is shaped to admit it without a version
// bump (`@dim/contract/input`'s `appointment.ts`).
//
// WHAT THE WEB DOES NOT HAVE EITHER, RECORDED RATHER THAN QUIETLY MIRRORED
// ---------------------------------------------------------------------------
// The browser's cancel has NO rate limit of any kind: `cancelAppointmentByOwnerAction`
// is a bare server action behind `requireUserOrRedirect`. This door does have one,
// because every write on `/api/v1` takes the shared authenticated-write family,
// and that is the right direction — but it means the phone is bounded where the
// browser is not. It is a gap on the WEB, and it is recorded here rather than
// closed here, because closing it means editing an action the browser also uses.
//
// There is also NO CANCELLATION WINDOW anywhere in this feature. The only clock
// rule is `starts_at > now()`: an owner may cancel a turno sixty seconds before
// it starts and the clinic learns about it from a notification. Whether that
// should have a floor (two hours? a day?) is a product question, not an agent's,
// and it is written down here because a reader looking for the window will
// otherwise assume it is enforced somewhere they have not read yet.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// `cancelAppointmentByOwner` takes no `clientIdempotencyKey`. What it has — an
// UPDATE conditional on `status = 'confirmed'` — REFUSES a replay rather than
// absorbing one, which is not the same guarantee and must not be sold as it.
// `@dim/contract/input`'s `appointment.ts` states the consequence a client has to
// handle.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { appointmentCommandInputSchema } from "@dim/contract/input";

import { readAppointments, runAppointmentCommand, unavailable } from "./commands";
import { buildMyAppointmentsV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// FOUR BUDGETS, TWO FAMILIES, AND THE NUMBERS ARE NOT IN THIS FILE. GET is the
// authenticated-READ family; POST is the authenticated-WRITE family. Both sets of
// ceilings, and the carrier-NAT arithmetic that produced them, live in
// lib/infra/api-v1-limits.ts. The BUCKET NAMES stay here as literals, and that
// separation is deliberate: a shared ceiling is a decision about load, and a
// shared counter would make "which surface is being hammered" unanswerable from
// the limiter's own storage. Same numbers, four buckets.

// AUTHORIZED, not opted out: both handlers call requireLiveUser, and the write's
// per-row authorization then runs inside the use-case — which is where it has to
// be, because the rule is the appointment's own `owner_user_id` and not a
// property of the animal. Said here for a reader scanning for the guard, and said
// WITHOUT writing the opt-out marker, because a comment that spells the marker in
// order to deny it still reads as one to a scanner matching the token.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_appointments_read_ip",
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
      "api-v1-me-appointments-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_appointments_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // ONE `now` FOR THE WHOLE RESPONSE, taken here and threaded through. The read
  // uses it to bucket and to decide both capabilities, and the envelope stamps
  // `issuedAt` with it; a second `new Date()` in the payload builder would let a
  // row be classified against one instant and dated against another.
  const now = new Date();

  let appointments: Awaited<ReturnType<typeof readAppointments>>;
  try {
    appointments = await readAppointments({ userId: live.user.id, now });
  } catch (err) {
    // NOT an empty hub. A read that failed and a person with no turnos are
    // different facts, and a client that rendered "no tenés turnos" over a pooler
    // outage would have somebody miss an appointment they have to attend.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyAppointmentsV1({ appointments, now }), { status: 200 });
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_appointments_write_ip",
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
      "api-v1-me-appointments-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_appointments_write_user",
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
  const parsed = appointmentCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runAppointmentCommand({ userId: live.user.id, input: parsed.data });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter in
 * this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop somebody CANCELLING a turno they cannot
 * attend — and on this surface that is the operation that must never be blocked
 * by an abuse control, because the alternative is a place held by somebody who
 * will not show up while a queue exists for it. The authorization boundary stays
 * intact and fails CLOSED.
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
    reportError(`api-v1-me-appointments/${endpoint}`, err);
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
