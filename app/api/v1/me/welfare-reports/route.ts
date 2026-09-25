// `GET /api/v1/me/welfare-reports` — "Mis denuncias": the denuncias the
// signed-in caller filed under their account, newest first, with each one's
// status (M16).
//
// It is the web's `/denuncias/mias`, read through the same reader
// (`listReporterWelfareReports`, `reporter-reports-read.ts`) keyed on the
// verified caller — see `./commands.ts`. The id comes from `requireLiveUser`,
// never from the request.
//
// ANONYMOUS DENUNCIAS ARE NOT HERE, and not because this route filters them:
// one filed anonymously is stored with `reporter_user_id = null`, so no
// account's list can reach it. Its author follows it with the reference code
// and the e-mailed access link, exactly as on the web.
//
// CURSOR-PAGINATED (D5 pattern). `?cursor=` is optional; absent or malformed it
// decodes to `null` and this is page one. `decodeCursor`/`encodeCursor` are the
// codec `/me/pets`, `/me/notifications` and `/adoptions` use.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { decodeCursor } from "@/lib/utils/keyset-pagination";

import { readReports, unavailable } from "./commands";
import { buildMyWelfareReportsV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and the reader it then runs is scoped to that verified user's id.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_welfare_reports_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-welfare-reports-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_welfare_reports_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor"));

  let list: Awaited<ReturnType<typeof readReports>>;
  try {
    list = await readReports(live.user.id, cursor);
  } catch (err) {
    // NOT an empty list. "Aún no enviaste denuncias" over a pooler outage would
    // tell somebody their allegation was never recorded.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyWelfareReportsV1({ list, now: new Date() }), { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 * FAILS OPEN on limiter infrastructure failure, like every sibling: the
 * authorization boundary is what must fail closed, and it does.
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
    reportError(`api-v1-me-welfare-reports/${endpoint}`, err);
    return true;
  }
}

/** The liveness guard's refusals, with the SAME statuses and codes as every sibling. */
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
