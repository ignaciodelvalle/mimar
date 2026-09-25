// POST /api/v1/me/reactivate — D4, "Reactivar mi cuenta" for the native client.
//
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
// A person who deactivated their OWN personal account meets `account_deactivated`
// on every request. The web has always had the way back — the reactivation card
// on /cuenta, `selfReactivatePersonalAccountAction` — and the app used to answer
// the same refusal with "podés volver a activarla desde Mi cuenta en la web".
// This is that card's door for the phone, and it is deliberately NOTHING MORE:
// the act is `selfReactivatePersonalAccountForUser`, the web's own use-case,
// called unchanged — same checks, same anti-race UPDATE, same transaction, same
// `personal_self_reactivated` audit row.
//
// WHY THIS ROUTE MAY RUN FOR A CALLER `requireLiveUser` REFUSES
// ---------------------------------------------------------------------------
// It is the one `/api/v1` handler that proceeds on a `DEACTIVATED` refusal, for
// the reason the web action gives for being gated on `requireUserOrRedirect`
// instead: this door's ONLY legitimate caller is a deactivated one, so refusing
// DEACTIVATED here would make the reactivation button refuse itself. Every OTHER
// refusal keeps its ordinary answer. In particular ACCOUNT_ERASED outranks
// DEACTIVATED inside the guard, so an erased account never reaches the use-case
// from here — Ley 25.326 art. 16 erasure is final, and the use-case re-checks
// `deleted_at` in the database (and again inside its UPDATE) anyway.
//
// WHO MAY UNDO A DEACTIVATION
// ---------------------------------------------------------------------------
// Only the person who did it, and the schema says who that was through
// `profiles.account_type`: every writer of `deactivated_at` other than the
// personal self-deactivation (`deactivate-govt`, `deactivate-admin`,
// `reset-institutional-credentials`, `govt-self-deactivate`) requires an
// INSTITUTIONAL account, and the personal one requires a PERSONAL one. So a
// deactivated personal account was deactivated by its owner, and a deactivated
// institutional account was deactivated by an operator (or by a govt user whose
// self-deactivation hands coverage over and is not self-reversible either). The
// use-case refuses anything but `personal`; this route adds nothing to that rule
// and must not relax it.
//
// NO ORACLE
// ---------------------------------------------------------------------------
// The caller learns nothing about any account but the one its own bearer token
// already resolves to, and nothing about that one it was not already told: an
// institutional account keeps hearing `account_deactivated` (the refusal every
// other door gives it), an erased one keeps hearing `account_erased`. There is
// no parameter naming a subject — the user id comes from GoTrue validating the
// token, never from the body.
//
// THE RESPONSE
// ---------------------------------------------------------------------------
//   200 { reactivated: true }  — this call cleared `deactivated_at`.
//   200 { reactivated: false } — the account was already active: a live session,
//                                or a concurrent call won the anti-race UPDATE.
//                                Idempotent, so a retried tap is not an error.
//   403 account_deactivated    — not a self-reversible deactivation.
//   403 account_erased         — erased; stays erased.
//
// RATE LIMITED TWICE, BOTH FAILING CLOSED. The per-IP bucket runs before
// authentication, as on every sibling. The per-user bucket runs after the guard,
// keyed on the GoTrue-validated id. See `API_V1_ACCOUNT_SECURITY_USER_LIMIT` for
// why it lives here and not in the web's use-case, and why this door fails
// closed where `revoke-sessions` fails open.
//
// A BARE PAYLOAD and NO Idempotency-Key, for `revoke-sessions`'s reasons: a
// write is not a snapshot, and the act is naturally idempotent.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_ACCOUNT_SECURITY_IP_LIMIT,
  API_V1_ACCOUNT_SECURITY_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { selfReactivatePersonalAccountForUser } from "@/src/modules/pets/application/profile/self-reactivate-personal-account";
import type { PersonalSelfReactivateResult } from "@/src/modules/pets/application/profile/types";

export const dynamic = "force-dynamic";

/** One `auth.getUser()` round-trip to GoTrue plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The bare write payload. See the header for what `false` means. */
type AccountReactivatedV1 = { reactivated: boolean };

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body
// and that call IS the authorization — including for the one refusal it acts on,
// whose user id is GoTrue's answer for the token, not the caller's claim.
export async function POST(request: Request) {
  // Free: a regex over one header, before any counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header
  // (check-api-guard-headers).
  try {
    await enforceRateLimit(
      "api_v1_me_reactivate_ip",
      callerIp(request.headers),
      API_V1_ACCOUNT_SECURITY_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL CLOSED — see the header.
    reportError("api-v1-me-reactivate/ip-limit", err);
    return unavailable();
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-reactivate",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  let userId: string;
  if (live.ok) {
    userId = live.user.id;
  } else {
    switch (live.reason) {
      case "NO_SESSION":
        return apiV1Error("auth_expired", 401);
      case "ACCOUNT_ERASED":
        return apiV1Error("account_erased", 403);
      case "DEACTIVATED":
        // THE ONE REFUSAL THIS DOOR ACTS ON. `user` is always populated on it
        // (live-user.ts): the session resolved, the account is merely off.
        if (live.user === null) return apiV1Error("auth_expired", 401);
        userId = live.user.id;
        break;
      case "SHIFT_EXPIRED":
        return apiV1Error("session_shift_expired", 401);
      case "MAINTENANCE":
        return unavailable();
      default: {
        const unhandled: never = live.reason;
        throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  try {
    await enforceRateLimit("api_v1_me_reactivate_user", userId, API_V1_ACCOUNT_SECURITY_USER_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    reportError("api-v1-me-reactivate/user-limit", err, { userId });
    return unavailable();
  }

  // A LIVE SESSION HAS NOTHING TO UNDO, and the use-case is NOT asked. For a
  // live personal account it would answer the same no-op; for a live
  // INSTITUTIONAL one it would answer ROLE_MISMATCH, which this route could only
  // render as `account_deactivated` — telling an active operator their account
  // is off. The guard has just said it is live, so that is the answer.
  if (live.ok) {
    const payload: AccountReactivatedV1 = { reactivated: false };
    return apiV1Json(payload, { status: 200 });
  }

  return answerFor(await selfReactivatePersonalAccountForUser(userId), userId);
}

/** The wire answer for the web's use-case result. */
function answerFor(result: PersonalSelfReactivateResult, userId: string) {
  if ("error" in result) {
    // Mapped by the use-case's own error prefixes. Neither refusal tells the
    // caller anything its session was not already told by the guard.
    if (result.error.startsWith("ACCOUNT_ERASED")) return apiV1Error("account_erased", 403);
    if (result.error.startsWith("ROLE_MISMATCH") || result.error === "NOT_FOUND") {
      return apiV1Error("account_deactivated", 403);
    }
    // Anything else is the transaction failing. Never 200: the person's next
    // move depends on believing the account is back.
    reportError("api-v1-me-reactivate/use-case", new Error(result.error), { userId });
    return unavailable();
  }
  const payload: AccountReactivatedV1 = { reactivated: result.noOp !== true };
  return apiV1Json(payload, { status: 200 });
}
