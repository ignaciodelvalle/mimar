// `GET /api/v1/me/welfare-reports/{referenceCode}` — one denuncia the caller
// filed, as `/denuncias/{id}` shows it to its author (M16).
//
// THE AUTHORIZATION IS THE WEB'S READER, NOT A COPY OF IT. `readReport`
// (`../commands.ts`) runs `getReporterWelfareReport`, the function the web page
// renders from, with `reporter_user_id = <verified caller>` in the SAME query
// as the code. The path segment is only ever the thing looked up, never who is
// looking.
//
// SOMEBODY ELSE'S DENUNCIA IS A 404, NOT A 403 — and so is an anonymous one and
// one that does not exist. The three must be indistinguishable, or this becomes
// an oracle over reference codes (and over whether a given code was filed
// anonymously, which is the one thing anonymity exists to keep unwritten).

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

import { readReport, unavailable } from "../commands";
import { buildMyWelfareReportDetailV1 } from "../payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * Longer than any reference code the system mints (`DEN-XXXX-XXXX`). A longer
 * segment names nothing, and answering it without a query keeps a hammer of
 * junk segments off the read.
 */
const MAX_REFERENCE_CODE_LENGTH = 64;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body,
// and the read it then runs is scoped to that verified reporter.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ referenceCode: string }> },
) {
  const { referenceCode } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_welfare_report_detail_ip",
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
      "api-v1-me-welfare-report-detail-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_welfare_report_detail_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  if (referenceCode.length === 0 || referenceCode.length > MAX_REFERENCE_CODE_LENGTH) {
    return apiV1Error("not_found", 404);
  }

  let read: Awaited<ReturnType<typeof readReport>>;
  try {
    read = await readReport(live.user.id, referenceCode);
  } catch (err) {
    // NOT a 404. A database outage is not "this denuncia does not exist".
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (read === null) return apiV1Error("not_found", 404);

  return apiV1Json(
    buildMyWelfareReportDetailV1({ detail: read.detail, evidence: read.evidence, now: new Date() }),
    { status: 200 },
  );
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
    reportError(`api-v1-me-welfare-report-detail/${endpoint}`, err);
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
