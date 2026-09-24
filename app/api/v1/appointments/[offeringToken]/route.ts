// `/api/v1/appointments/{offeringToken}` — one service's slot grid, and which of
// the caller's animals may take a place.
//
// WHY THE PETS COME BACK WITH THE SLOTS
// ---------------------------------------------------------------------------
// The web splits this across two pages: `/turnos/buscar/{offering}` draws the
// grid, and `/turnos/buscar/{offering}/reservar/{slotId}` draws the pet picker
// after somebody has picked a time. Splitting it here would mean a second route,
// a second bucket and a round trip in the middle of a two-tap flow — for a list
// of the caller's own animals that is at most a handful of rows and that the
// grid's own screen has to know about anyway: it cannot honestly offer a slot to
// somebody with no bookable animal.
//
// SO THE REFUSALS ARE VISIBLE BEFORE THE TAP, which is this door's whole design.
// `bookSlotWriter` refuses a second CONFIRMED appointment for the same (pet,
// offering) pair, and that guard is invisible in a slot grid — the same animal
// taking the 08:00 AND the 08:15 of one free campaign is what it was added for
// (QA A3, 2026-08-13). `pets[].canBook` carries it, so the screen greys the
// animal instead of the person discovering it by being refused.
//
// A 404 COVERS "NOT APPROVED", exactly as the web's page does (`notFound()` at
// `[offeringToken]/page.tsx:43`). A pending, paused or archived offering must be
// indistinguishable from a token that names nothing, or this URL is an oracle for
// which offerings exist and which are merely switched off.
//
// ONE READ BUCKET WITH ITS PARENT — `api_v1_appointment_search_ip`. Opening a
// grid is what a person does FROM the results, several times in one sitting; two
// budgets for one behaviour would say the list and the grid are bounded
// independently, and they are not. The argument is the adoption catalogue's and
// the ficha's, and it is theirs.

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
import { readBookableOffering } from "@/src/modules/events/application/booking/search-bookable-slots";

import { buildBookableOfferingDetailV1 } from "../payload";

export const dynamic = "force-dynamic";

const AUTH_BUDGET_MS = 5_000;

/**
 * Three indexed SELECTs — the offering, its slots over sixty days, and the
 * caller's pets with their per-offering booking left-joined.
 *
 * A DEGRADED READ ANSWERS 503, NEVER AN EMPTY GRID, for the reason the search
 * route gives: "there are no times left" and "we could not ask" are different
 * facts and only one of them should send somebody away.
 */
const DETAIL_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard, and said WITHOUT writing the opt-out marker.
export async function GET(
  request: Request,
  context: { params: Promise<{ offeringToken: string }> },
) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_appointment_search_ip",
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
      "api-v1-appointment-offering-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_appointment_search_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  const { offeringToken } = await context.params;
  // ONE `now` for the whole response — the grid's floor and the envelope's
  // `issuedAt` are the same instant, so a slot cannot be selected against one and
  // dated against another.
  const now = new Date();

  let detail: Awaited<ReturnType<typeof readBookableOffering>>;
  try {
    detail = await withDbBudgetOrThrow(
      readBookableOffering({ offeringToken, userId: live.user.id, now }),
      DETAIL_BUDGET_MS,
      "api-v1-appointment-offering",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!detail) return apiV1Error("not_found", 404);

  return apiV1Json(buildBookableOfferingDetailV1({ detail, now }), { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching its parent route and
 * every sibling on this surface. The authorization boundary above fails CLOSED.
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
    reportError(`api-v1-appointment-offering/${endpoint}`, err);
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
