// `GET /api/v1/me/cases/{publicCode}` — one case, as the signed-in caller may
// read it.
//
// THE AUTHORIZATION IS THE WEB'S, NOT A COPY OF IT. `readCase` (`../commands.ts`)
// runs `readCaseForViewer` (`lib/infra/case-read.ts`) — `canReadCase`, the
// caretaker distinction, the authority PII trail and the dispute-tip filter —
// which is the function `/casos/{publicCode}` renders from. The viewer is built
// from `requireLiveUser`'s verified profile; the path segment is only ever the
// thing looked up, never who is looking.
//
// A CASE THE CALLER MAY NOT READ IS A 404, NOT A 403, and so is one that does
// not exist: the two must be indistinguishable, or this becomes an oracle over
// case codes. The one exception is the caller who is the pet's LIVE caretaker,
// who gets a 200 with `access: "caretaker_only"` — exactly the page the web
// shows them, and nobody else can reach that branch.

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

import { readCase, unavailable } from "../commands";
import { buildMyCaseDetailV1 } from "../payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * Longer than any case code the system mints (`CAS-XXXX-XXXX`). A longer
 * segment names nothing, and answering it without a query keeps a hammer of
 * junk segments off the multi-join read.
 */
const MAX_PUBLIC_CODE_LENGTH = 64;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body,
// and the read it then runs is gated by canReadCase for that verified viewer.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicCode: string }> },
) {
  const { publicCode } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_case_detail_ip",
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
      "api-v1-me-case-detail-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_case_detail_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  if (publicCode.length === 0 || publicCode.length > MAX_PUBLIC_CODE_LENGTH) {
    return apiV1Error("not_found", 404);
  }

  let read: Awaited<ReturnType<typeof readCase>>;
  try {
    read = await readCase({ publicCode, profile: live.profile });
  } catch (err) {
    // NOT a 404. A database outage is not "this case does not exist".
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (read.kind === "not_found") return apiV1Error("not_found", 404);

  return apiV1Json(buildMyCaseDetailV1({ read, now: new Date() }), { status: 200 });
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
    reportError(`api-v1-me-case-detail/${endpoint}`, err);
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
