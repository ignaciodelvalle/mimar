// `GET /api/v1/me/notifications/{notificationId}/target` — where one of the
// caller's notifications leads, decided now (notificaciones-destinos, 2026-10).
//
// THE APP ASKS THIS AT TAP TIME, from the push tap and from the inbox, so the
// route comes from the server that knows today's access rules rather than from
// the `cta_url` a writer stored months ago or the deep-link table baked into an
// installed build. The decision is `resolveNotificationTarget`, the same function
// the web's `/notificaciones/{id}/abrir` redirect runs: one rule, two doors.
//
// NEVER A DEAD END. The answer always names somewhere the viewer can go — the
// case, the pet, a section, or the explanation screen, which says why the
// destination is gone and who has to act. See `@dim/contract/api`'s
// `notification-target.ts`.
//
// A 404 MEANS "NOT YOUR NOTIFICATION", never "the destination is gone": an id
// belonging to somebody else and one belonging to nobody answer identically, so
// this endpoint is no oracle over other people's notification ids.

import { notificationTargetPorts } from "@/app/_composition/notification-target-ports";
import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { caseViewerFromProfile } from "@/lib/infra/case-read";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { resolveOwnNotificationTarget } from "@/src/modules/notifications/infrastructure/notification-target-probes";
import {
  NOTIFICATION_TARGET_PAYLOAD_VERSION,
  NOTIFICATION_TARGET_STALE_AFTER_MS,
  type NotificationTargetV1,
} from "@dim/contract/api";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The row, then at most a case detail, a pet and two access reads. */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * Spend one rate-limit budget. FAILS OPEN on limiter infrastructure failure,
 * like every sibling: refusing here would strand a tap over an abuse control on
 * a read that only ever concerns the caller's own rows.
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
    reportError(`api-v1-me-notification-target/${endpoint}`, err);
    return true;
  }
}

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body,
// and the resolver reads only the caller's own row — those two ARE the
// authorization.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
) {
  const { notificationId } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_notification_target_ip",
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
      "api-v1-me-notification-target-auth",
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
      "api_v1_me_notification_target_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // A profile is missing only in the mid-signup window; such an account has no
  // notifications to resolve.
  if (!live.profile) return apiV1Error("not_found", 404);
  const profile = live.profile;

  let target: Awaited<ReturnType<typeof resolveOwnNotificationTarget>>;
  try {
    target = await withDbBudgetOrThrow(
      (async () => {
        const viewer = await caseViewerFromProfile(profile);
        if (!viewer) return null;
        return resolveOwnNotificationTarget(notificationId, viewer, notificationTargetPorts);
      })(),
      RESOLVE_BUDGET_MS,
      "api-v1-me-notification-target-resolve",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (target === null) return apiV1Error("not_found", 404);

  const payload: NotificationTargetV1 = {
    ...apiV1Envelope({
      payloadVersion: NOTIFICATION_TARGET_PAYLOAD_VERSION,
      staleAfterMs: NOTIFICATION_TARGET_STALE_AFTER_MS,
    }),
    ...target,
  };
  return apiV1Json(payload, { status: 200 });
}
