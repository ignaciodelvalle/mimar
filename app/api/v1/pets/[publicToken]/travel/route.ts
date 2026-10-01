// `/api/v1/pets/{publicToken}/travel` — the owner's trips (viajes-fase-2).
//
// GET reads the owner's trips, their CVIs and the SERVER-computed semáforo of
// one trip (`?trip=`, the next one by default) — through `loadTravelView`, the
// loader the web /viaje page renders from (`./payload.ts`).
//
// POST, FOUR COMMANDS BEHIND ONE URL — `record_trip`, `record_cvi`,
// `cancel_trip`, `confirm_trip_document` — the shape `/reminders` and `/lost` use; `./commands.ts`
// answers "may this command run, and what exactly does it do".
//
// `Idempotency-Key` IS REQUIRED FOR ALL FOUR. Each appends a row on the
// append-only spine, and the retry that matters is a phone's after a timeout
// that may have committed: the key makes it answer the first write.
//
// TWO FAMILIES, ONE FILE: the read takes `authenticated-read`, the write the
// generic `authenticated-write` — see both buckets' entries in
// lib/infra/api-v1-limits.ts.

import { apiV1Error } from "@/lib/infra/api-v1";
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
import { isValidIdempotencyKey } from "@dim/contract/api";
import { petTravelCommandInputSchema } from "@dim/contract/input";

import { runPetTravelCommand, unavailable } from "./commands";
import { readPetTravel } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** A `?trip=` value worth looking up: UUID-shaped, else ignored. */
const TRIP_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// AUTHORIZED, not opted out: both handlers call requireLiveUser and then
// resolve pet access, and those two calls ARE the authorization. Said here
// for a reader scanning for the guard — and said WITHOUT writing the opt-out
// marker, because a comment that spells the marker in order to deny it still
// reads as one to a scanner matching the token.
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
      "api_v1_travel_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body, like the write's copy — `check-api-v1-envelope` reads
  // the handler body only and cannot see through a shared helper.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-travel-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_travel_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  const trip = (new URL(request.url).searchParams.get("trip") ?? "").trim();

  return readPetTravel({
    publicToken,
    userId: live.user.id,
    tripId: TRIP_ID_RE.test(trip) ? trip : null,
  });
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
      "api_v1_travel_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-travel-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_travel_write_user",
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
  // locally. This is the backstop for a client out of step with the contract.
  const parsed = petTravelCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  const rawKey = (request.headers.get("idempotency-key") ?? "").trim();
  if (!isValidIdempotencyKey(rawKey)) return apiV1Error("idempotency_key_required", 400);

  return runPetTravelCommand({
    publicToken,
    userId: live.user.id,
    idempotencyKey: rawKey,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface, while the AUTHORIZATION boundary stays intact and fails
 * CLOSED.
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
    reportError(`api-v1-travel/${endpoint}`, err);
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
