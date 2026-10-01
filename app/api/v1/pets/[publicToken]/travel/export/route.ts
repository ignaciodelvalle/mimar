// `POST /api/v1/pets/{publicToken}/travel/export[?trip=]` — the travel PDF for
// the native app (viajes-fase-2, task 6.5).
//
// The web's /viaje page hands its owner a signed link to the travel PDF; the
// native screen had no way to get one, and a link out to the web would have hit
// the web login wall. This is the bearer door to the SAME use-case
// (`./export.ts`), answering the same signed link as JSON — `apiV1Json`, so the
// `cache-control: no-store` and the `{ error }` envelope are the helper's, like
// every sibling. The app downloads the PDF from the link and shares the file.
//
// NOT BYTES ON THE WIRE, deliberately: the `/api/v1` client reads JSON only,
// every response goes through `apiV1Json`/`apiV1Error`
// (`check-api-v1-envelope`), and the web export already produces the file in
// Storage with a signed link. One PDF, one place it is made.
//
// A POST: each call stores a file and writes an audit row. No
// `Idempotency-Key` — nothing lands on the append-only spine, and a retry
// after a lost response just makes a second copy of the same PDF.
//
// ITS OWN BUCKETS in the `authenticated-write` family — see the entry in
// lib/infra/api-v1-limits.ts.

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

import { unavailable } from "../commands";
import { exportPetTravel } from "./export";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** A `?trip=` value worth looking up: UUID-shaped, else ignored. */
const TRIP_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// AUTHORIZED, not opted out: the handler calls requireLiveUser and then
// resolves pet access (./export.ts), and those two calls ARE the authorization.
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
      "api_v1_travel_export_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body — `check-api-v1-envelope` reads the handler body only.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-travel-export-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_travel_export_user",
      live.user.id,
      API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  const trip = (new URL(request.url).searchParams.get("trip") ?? "").trim();

  return exportPetTravel({
    publicToken,
    userId: live.user.id,
    tripId: TRIP_ID_RE.test(trip) ? trip : null,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 * FAILS OPEN on limiter infrastructure failure, like every sibling limiter;
 * the authorization boundary stays intact and fails CLOSED.
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
    reportError(`api-v1-travel-export/${endpoint}`, err);
    return true;
  }
}

/** The liveness guard's refusals — the same statuses and codes as every sibling. */
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
