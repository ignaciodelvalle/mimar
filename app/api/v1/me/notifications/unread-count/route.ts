// `/api/v1/me/notifications/unread-count` — the number on the app's bell.
//
// WHY THIS EXISTS BESIDE `GET /me/notifications`
// ---------------------------------------------------------------------------
// The native header carries a bell with an unread badge (inicio-app-rediseno,
// PO 2026-10-07) and re-reads it every time "Mis mascotas" or a pet screen comes
// back into focus. The inbox read carries the same number, but beside a page of
// up to a hundred rows and the per-category counts — the size of the inbox, on a
// Samsung J7, to draw one digit, on a screen that already makes four reads per
// focus. This answers the aggregate alone, through the SAME
// `fetchUnreadNotificationCount` call the inbox makes (see `readUnreadCount`), so
// the bell and the inbox cannot disagree.
//
// GUARDED EXACTLY LIKE ITS PARENT. Same bearer, same liveness guard with the same
// refusals — including the legal re-acceptance gate, which this route does NOT
// opt out of: it is not one of the surfaces a person must reach before accepting
// (`__tests__/api-v1-legal-gate-wiring.test.ts` lists those), and a bell with no
// number is exactly what a refused read should leave behind. Its OWN two buckets
// in the authenticated-read family, because one surface must not spend another's
// counter: a bell re-read on every focus would otherwise eat the inbox's budget.

import {
  MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION,
  MY_UNREAD_NOTIFICATIONS_STALE_AFTER_MS,
  type MyUnreadNotificationsV1,
} from "@dim/contract/api";

import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";

import { readUnreadCount, unavailable } from "../commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and the aggregate is scoped to the caller's own id — those two ARE the
// authorization.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_notifications_unread_ip",
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
      "api-v1-me-notifications-unread-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) {
    switch (live.reason) {
      case "NO_SESSION":
        return apiV1Error("auth_expired", 401);
      case "ACCOUNT_ERASED":
        return apiV1Error("account_erased", 403);
      case "DEACTIVATED":
        return apiV1Error("account_deactivated", 403);
      case "SHIFT_EXPIRED":
        return apiV1Error("session_shift_expired", 401);
      case "LEGAL_ACCEPTANCE_REQUIRED":
        return apiV1Error("legal_acceptance_required", 403);
      case "CLIENT_UPGRADE_REQUIRED":
        return apiV1Error("client_upgrade_required", 426);
      case "MAINTENANCE":
        return unavailable();
      default: {
        const unhandled: never = live.reason;
        throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  if (
    !(await spendBudget(
      "api_v1_me_notifications_unread_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let unreadCount: number;
  try {
    unreadCount = await readUnreadCount(live.user.id);
  } catch (err) {
    // NOT a zero. A count that could not be read and an inbox with nothing
    // unread are different facts; the client hides its badge on this answer.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  const payload: MyUnreadNotificationsV1 = {
    ...apiV1Envelope({
      payloadVersion: MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION,
      staleAfterMs: MY_UNREAD_NOTIFICATIONS_STALE_AFTER_MS,
    }),
    unreadCount: Math.max(0, unreadCount),
  };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, like its parent route: the
 * authorization boundary stays intact and fails CLOSED — that is the one that
 * must.
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
    reportError(`api-v1-me-notifications-unread-count/${endpoint}`, err);
    return true;
  }
}
