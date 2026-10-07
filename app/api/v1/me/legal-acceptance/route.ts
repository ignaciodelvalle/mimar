// `POST /api/v1/me/legal-acceptance` — an existing account accepts the current
// legal version, from the app (2026-10-07).
//
// WHY IT EXISTS (legal review 2026-10-02, rows P10, P11 and D5; PO decision
// D2 = b, conservative interim): a substantive change of the Terms needs a new
// acceptance, not an email (Disp. 377/2026 inc. b), and accounts created before
// this version consented to the international transfer inside the Terms box
// rather than in a box of its own (Dec. 1558/2001 art. 5 inc. 1). `GET /me`
// answers `legalAcceptancePending: true` for such an account; the app sends the
// person to its re-acceptance screen, whose submit is this. The web twin is the
// server action behind /aceptar-condiciones; both call `acceptLegalTermsForUser`.
//
// THE RESPONSE CARRIES THE FRESH USER (`LegalAcceptedV1`), for `/me/identity`'s
// reason: the caller called because its stored user is stale, and a bare
// acknowledgement would leave its gate refusing until a second round trip.
//
// A VERSION OTHER THAN THE SERVER'S CURRENT ONE IS `invalid_request`, whose copy
// on the phone asks to update the app: that client displayed an older text, and
// recording it would either assert a consent to a text never shown or leave the
// person on the gate forever.
//
// NO Idempotency-Key: accepting is a VALUE. A second call on an account already
// on the current version answers the same 200 with no write and no audit row.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { acceptLegalTermsForUser } from "@/src/modules/auth/application/accept-legal-terms";
import type { LegalAcceptedV1 } from "@dim/contract/api";
import { legalAcceptanceInputSchema } from "@dim/contract/input";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

/** One read, one UPDATE and one audit INSERT on indexed single rows. */
const ACCEPTANCE_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization (same wording as `/me/identity`, for the
// scanner's reason given there).
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // IP first, before the GoTrue round trip, so an unauthenticated hammer is
  // refused cheaply — the `authenticated-write` family, like `/me/identity`.
  if (
    !(await spendBudget(
      "api_v1_me_legal_acceptance_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-legal-acceptance-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_legal_acceptance_user",
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

  // The app validated against THIS schema first and showed per-box sentences
  // locally; this is the backstop for a client out of step with the contract.
  const parsed = legalAcceptanceInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  let result: Awaited<ReturnType<typeof acceptLegalTermsForUser>>;
  try {
    result = await withDbBudgetOrThrow(
      // `live.user.id` and NOT anything from the body.
      acceptLegalTermsForUser({
        userId: live.user.id,
        email: live.user.email,
        tosAccepted: parsed.data.tosAccepted,
        transferAccepted: parsed.data.transferAccepted,
        adultDeclared: parsed.data.adultDeclared,
        legalVersion: parsed.data.legalVersion,
      }),
      ACCEPTANCE_BUDGET_MS,
      "api-v1-me-legal-acceptance-write",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!result.ok) {
    const refusal = result.error;
    switch (refusal) {
      // Both mean "this client is out of step": the schema already required
      // the three boxes, and a version mismatch is an old bundle.
      case "NOT_ACCEPTED":
      case "VERSION_MISMATCH":
        return apiV1Error("invalid_request", 400);
      case "WRITE_FAILED":
        reportError("api-v1-me-legal-acceptance", new Error("legal acceptance write failed"));
        return unavailable();
      default: {
        const unhandled: never = refusal;
        throw new Error(`Unhandled legal acceptance refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const payload: LegalAcceptedV1 = { user: result.user };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one rate-limit budget. FAILS OPEN on limiter infrastructure failure,
 * like every sibling on this surface: refusing here would strand a person on
 * the re-acceptance gate over an abuse control. The authorization above is the
 * boundary that fails closed.
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
    reportError(`api-v1-me-legal-acceptance/${endpoint}`, err);
    return true;
  }
}

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/** The liveness refusals, mapped like every sibling on this surface. */
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
