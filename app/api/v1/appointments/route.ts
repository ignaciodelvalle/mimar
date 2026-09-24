// `/api/v1/appointments` — BUSCAR UN TURNO.
//
// WHY THIS DOES NOT HANG OFF `/me`
// ---------------------------------------------------------------------------
// Every other appointment URL on this surface does, because it is about turnos
// this person holds. This one is about turnos NOBODY holds yet: it reads the
// national catalogue of approved service offerings and the places they still
// have open. Filing it under `/me` would say the answer depends on who is asking,
// and it does not — the same query with the same filters answers the same for
// every caller. What DOES depend on the caller is one thing and it is named on
// the wire: `jurisdictionSource`, when the search had to guess a province and a
// locality from the person's first registered pet.
//
// IT STILL NEEDS A SESSION, and for `GET /api/v1/adoptions`'s reason rather than
// for an authorization one. The web's `/turnos/buscar` is behind
// `requireUserOrRedirect`, this app has no anonymous shell, the funnel ends at a
// session anyway, and an anonymous `/api/v1` read is a DIFFERENT rate-limit
// derivation (`credential/limits.ts` sizes against 1,000 subscribers per carrier
// address because a stranger with a camera needs no account) rather than a
// smaller one. So the guard is the web's, copied, not re-derived.
//
// TWO ROUTES, ONE READ BUCKET — see `api_v1_appointment_search_ip` in
// `lib/infra/api-v1-limits.ts`. Opening one offering's grid is what a person does
// FROM these results, several times in one sitting, and the two calls are one act
// of looking for a turno. It is the arrangement the adoption catalogue and its
// ficha already share, and the argument is theirs.
//
// AN UNKNOWN `service_kind` IS TREATED AS ABSENT AND NEVER ECHOED. QA 2026-08-08
// (S3-F07) loaded `?service_kind=spay_female_dog` on the web and got a 200 whose
// `<h1>` read `spay_female_dog`, because the page used the raw param as its
// heading. React escaped the markup, so it was never injection — it was the page
// asserting a service that does not exist. Here the payload carries
// `serviceKind: null` and the full catalogue, so a client redraws the picker.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { searchBookableOfferings } from "@/src/modules/events/application/booking/search-bookable-slots";

import { buildAppointmentSearchV1 } from "./payload";
import { defaultJurisdictionForUser, parseSearchQuery } from "./query";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * Two indexed SELECTs — the offerings, then their slots in one `IN` — bounded
 * because `force-dynamic` means every call runs them.
 *
 * A DEGRADED READ HERE ANSWERS 503, NEVER AN EMPTY CATALOGUE. "No hay turnos
 * disponibles" and "we could not ask" are different facts, and a client that
 * rendered the first over a pooler outage would send somebody away from a
 * campaign that is running.
 */
const SEARCH_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard, and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner.
export async function GET(request: Request) {
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

  // CALLED IN THE HANDLER BODY, not through a helper the two routes share.
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT — and
  // that is the right rule rather than a limitation.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-appointment-search-auth",
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

  // ONE `now` FOR THE WHOLE RESPONSE, taken here and threaded through. The search
  // uses it as the window's floor and the envelope stamps `issuedAt` with it; a
  // second `new Date()` in the payload builder would let a slot be selected
  // against one instant and dated against another.
  const now = new Date();
  const query = parseSearchQuery(new URL(request.url).searchParams);

  // NO SERVICE CHOSEN — the picker, and no query at all. The web renders exactly
  // this and calls it "Indicá qué servicio buscás".
  if (!query.serviceKind) {
    return apiV1Json(
      buildAppointmentSearchV1({
        serviceKind: null,
        appliedProvince: null,
        appliedLocality: null,
        jurisdictionSource: "none",
        results: [],
        now,
      }),
      { status: 200 },
    );
  }

  try {
    // THE PREFILL IS THE WEB'S (`buscar/page.tsx:48-70`) and it runs only when the
    // caller supplied NEITHER half. Its result is reported as
    // `jurisdictionSource: "defaulted-from-pet"`, which the web does not do — the
    // browser draws the guessed locality into its own filter form, where it reads
    // as something the person asked for.
    const jurisdiction =
      query.province && query.locality
        ? { province: query.province, locality: query.locality, source: "requested" as const }
        : await withDbBudgetOrThrow(
            defaultJurisdictionForUser({ userId: live.user.id, query }),
            SEARCH_BUDGET_MS,
            "api-v1-appointment-search-jurisdiction",
          );

    const results = await withDbBudgetOrThrow(
      searchBookableOfferings({
        serviceKind: query.serviceKind,
        province: jurisdiction.province,
        locality: jurisdiction.locality,
        fromDate: query.fromDate,
        freeOnly: query.freeOnly,
        now,
      }),
      SEARCH_BUDGET_MS,
      "api-v1-appointment-search",
    );

    return apiV1Json(
      buildAppointmentSearchV1({
        // NON-NULL BY CONSTRUCTION: an unrecognised code already returned the
        // picker above. No `?? requested` fallback here — that is the very shape
        // that printed a raw param as a heading.
        serviceKind: findServiceKind(query.serviceKind)?.code ?? query.serviceKind,
        appliedProvince: jurisdiction.province,
        appliedLocality: jurisdiction.locality,
        jurisdictionSource: jurisdiction.source,
        results,
        now,
      }),
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter on
 * this surface. The limiter is itself a DB write; refusing when
 * `rate_limit_buckets` is unavailable would stop somebody FINDING a free
 * vaccination campaign, and this is a read that discloses a public catalogue. The
 * authorization boundary above stays intact and fails CLOSED.
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
    reportError(`api-v1-appointment-search/${endpoint}`, err);
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
