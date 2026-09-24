// `/api/v1/me/foster` — a volunteer's own tránsito inbox.
//
// GET reads the hub: proposals awaiting an answer, and every foster (active
// or ended) that came of one. POST runs one of the two commands the web
// offers a volunteer: aceptar, rechazar.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PROPOSAL OR A PET
// ---------------------------------------------------------------------------
// Same reason `me/caretaker-grants` does. A proposal is an offer to care for
// an animal the caller does not yet hold — the volunteer accepting it holds
// no `ownerships` row on the pet at the moment they answer — so a
// pet-scoped URL would invite an implementer to reach for
// `resolvePetHolderAccess`, which refuses the one caller each command exists
// for. See `@dim/contract/input`'s `foster.ts` for the full note.
//
// THE WEB HAS TWO PAGES, AND THIS IS NOT A DIVERGENCE — see `my-foster.ts`'s
// header. Both doors survive a phone poorly: `/cuenta/transitos/propuestas`
// and `/cuenta/transitos/activos` are each their own SSR query, and neither
// carries a token a cold-started native session would already have. Every
// row this returns is one the caller can already see on one of those two
// pages.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE — neither
// use-case takes a `clientIdempotencyKey`. Both re-read the proposal and
// refuse unless `status === "pending"`, so a replay is REFUSED rather than
// absorbed. `@dim/contract/input`'s `foster.ts` states the consequence a
// client has to handle.

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
import { fosterCommandInputSchema } from "@dim/contract/input";

import { readFosterHub, runFosterCommand, unavailable } from "./commands";
import { buildMyFosterV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The hub read's budget — two SELECTs (proposals, fosters) plus one extra
 * query PER FOSTER ROW (`listHubRowsForVolunteer`'s per-pet custody lookup,
 * bounded at `FOSTER_HUB_LIMIT`). Sized generously above `me/caretaker-grants`'s
 * `READ_BUDGET_MS` for exactly that fan-out.
 */
const READ_BUDGET_MS = 10_000;

// GET is the authenticated-READ family; POST is the authenticated-WRITE
// family. Both ceilings live in lib/infra/api-v1-limits.ts, shared with every
// other `/me` hub on this surface — see `me/caretaker-grants/route.ts` for
// the sizing rationale (accepting or declining a proposal is not a burst
// activity, and the daily figure is the abuse backstop).
//
// AUTHORIZED, not opted out: both handlers call requireLiveUser, and for the
// write the addressee match runs INSIDE the use-cases (`proposal.volunteerUserId
// === userId`) — which is where it has to be, because the caller holds no
// ownership row over the animal a proposal names. Said here for a reader
// scanning for the guard.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_foster_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper the two methods share —
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-foster-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_foster_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let hub: Awaited<ReturnType<typeof readFosterHub>>;
  try {
    hub = await withDbBudgetOrThrow(
      readFosterHub({ userId: live.user.id }),
      READ_BUDGET_MS,
      "api-v1-me-foster-list",
    );
  } catch (err) {
    // NOT an empty hub. A read that failed and a volunteer with nothing
    // pending are different facts, and a client that rendered "no tenés
    // propuestas" over a pooler outage would hide an animal waiting for a
    // home.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyFosterV1({ hub, now: new Date() }), { status: 200 });
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_foster_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body for the same reason the read's copy is — see the
  // note there.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-foster-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_foster_write_user",
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
  // locally. This is the backstop for a client out of step with the
  // contract, which is why it carries no field detail — the envelope is one
  // key.
  const parsed = fosterCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  try {
    return await runFosterCommand({ userId: live.user.id, input: parsed.data });
  } catch (err) {
    // Neither use-case budgets its own reads. Caught HERE so a degraded
    // write answers 503 rather than surfacing as `foster_failed`.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling
 * limiter on this surface: the authorization boundary stays intact
 * (`requireLiveUser` and the addressee match still run) and fails CLOSED —
 * only the abuse control fails open.
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
    reportError(`api-v1-me-foster/${endpoint}`, err);
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
