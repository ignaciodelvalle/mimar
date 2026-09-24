// B11 — "cerrar sesión en todos los dispositivos".
//
// WHY THIS IS A LAUNCH PREREQUISITE AND NOT A NICE-TO-HAVE
// ---------------------------------------------------------------------------
// It is the counterpart that makes B9's long citizen session defensible. A
// 30-day session is only acceptable if the person holding it can end it from
// somewhere else: a phone left on a bus, a borrowed laptop at a locutorio, a
// relative's tablet used once to show a credential. Without this, "long session"
// just means "long exposure". The two decisions ship together or neither does.
//
// ===========================================================================
// THE TRAP THIS FUNCTION EXISTS TO AVOID
// ===========================================================================
// The obvious implementation is `supabase.auth.signOut({ scope: "global" })`.
// On the COOKIE path that is correct. On the BEARER path it SILENTLY REVOKES
// NOTHING AND REPORTS SUCCESS, which on a security control is the worst
// available outcome — the user is told every device was signed out and none was.
//
// Verified in auth-js 2.105.4: `_signOut` calls `_useSession` → `__loadSession`,
// which reads the session from STORAGE and only from storage. A client built by
// `createClientFromBearer` has `persistSession: false` and never stored a
// session — it carries the token in an `Authorization` header instead. So
// `data.session` is null, the `if (accessToken)` guard around the actual
// `admin.signOut` call is skipped entirely, and the function returns
// `{ error: null }`. auth-js special-cases `hasCustomAuthorizationHeader` for
// `getUser`, and NOT for `signOut`.
//
// So this use-case takes the RAW TOKEN and calls the endpoint directly. There is
// no session-loading step to get wrong.
//
// ===========================================================================
// WHY NO SERVICE-ROLE CLIENT, DESPITE THE `auth.admin` NAMESPACE
// ===========================================================================
// `admin.signOut(jwt, scope)` reads as privileged and is not. Verified in
// auth-js 2.105.4: it POSTs `/auth/v1/logout?scope=<scope>` passing `{ jwt }`,
// and `_request` turns that into `Authorization: Bearer <jwt>` — the USER'S own
// token. The service-role key is never consulted for this call.
//
// It is also NOT `signOut(userId, ...)`, which is the shape one would guess and
// which does not exist here. The first argument is a valid logged-in JWT.
//
// That means the anon client is the correct client: the caller's own token is
// what authorizes revoking the caller's own sessions, which is exactly the
// authority we want and no more. Reaching for `createAdminClient()` would add a
// service-role code path to a user-triggered endpoint and buy nothing.
//
// ===========================================================================
// GLOBAL, SO THE CURRENT SESSION DIES TOO
// ===========================================================================
// GoTrue offers `others`, which spares the caller. The PO chose global, and the
// scope is the honest one for the button's promise: someone pressing "cerrar
// sesión en todos los dispositivos" because they think they were compromised
// should not have to reason about which device they are holding.
//
// Measured against local GoTrue v2.188.1: after `scope=global` the caller's own
// access token is rejected IMMEDIATELY (403 on /auth/v1/user — not "valid until
// exp") and its refresh token returns 400 `refresh_token_not_found`. Revocation
// is instant, which is what lets each surface promise something true: the web
// redirects to login, and the API answers 200 once and 401 to everything after.

// ===========================================================================
// WHY THIS WRITES AN AUDIT ROW, WHEN PLAIN LOGOUT DOES NOT
// ===========================================================================
// `logoutAction` writes nothing, and that is right: ending your own session on
// your own device is not an accountability event, it is navigation.
//
// This is not that. People press this button BECAUSE something went wrong — a
// lost phone, a shared machine they forgot to leave, a suspicion someone else
// got in. "When did the legitimate owner last cut every session?" is precisely
// the question an incident review asks, and it is unanswerable after the fact
// unless it was recorded when it happened. It also sits in the same family as
// the self-service account-state actions already in the catalog
// (`govt_self_deactivated`, `dni_verified_self`, `personal_self_deactivated`).
//
// There is no privacy cost: the subject, the actor and the beneficiary are the
// same person, and the row carries no PII beyond the actor FK that every other
// row already carries.
//
// It lives in the USE-CASE and not in the two surfaces on purpose. Migrations
// 0201 and 0202 exist because the caretaker actions wrote their audit rows at
// the call sites and three of six call sites simply did not — a grant could be
// created, accepted and ended leaving a trail of the first two. Two surfaces is
// two chances to forget; one writer is none.

// ===========================================================================
// AND WHY THE PER-USER LIMITER LIVES HERE TOO (2026-08-25)
// ===========================================================================
// It did not. `/api/v1/me/revoke-sessions` spent `api_v1_me_revoke_sessions_user`
// (5/min · 20/hr · 40/day) and its header argued at length why the bound is
// needed; the WEB action called the same use-case with no limiter at all. So the
// ceiling was a property of the TRANSPORT, and a caller holding a stolen cookie
// simply used the button instead of the endpoint.
//
// The fix is the shape `login` already uses (src/modules/auth/application/
// login.ts): the limiter lives in the SHARED use-case, so both surfaces spend
// the same budget and neither can be a way around the other. That is also why
// the bucket is named `revoke_sessions_user` and no longer `api_v1_…`: a name
// that says `api_v1` on a call from a web form reads like a different budget,
// and the whole point is that it is not one. (Renaming resets the counter once,
// which for an abuse control with a 1-minute window is nothing.)
//
// The IP bucket stays in the route and is NOT moved. It exists to make an
// UNAUTHENTICATED hammer cheap — it is applied before the token is validated, on
// a surface anyone can POST to. The web action is only reachable with a live
// cookie session that `requireLiveUser` has already resolved, so there is no
// pre-auth window to bound there.
//
// FAIL DIRECTION IS UNCHANGED AND IS THE OPPOSITE OF THE REVOCATION'S. A limiter
// that cannot answer lets the request through: refusing would deny someone the
// ability to sign out of a device they believe is compromised, over an abuse
// control. The revocation itself fails CLOSED, for the reason below.

import { db } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { type RateLimitConfig, RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createAnonClient } from "@/lib/supabase/anon";

/**
 * ONE bucket for both transports. Keyed on the user id, so it bounds an identity
 * rather than a device or a connection.
 */
export const REVOKE_SESSIONS_USER_BUCKET = "revoke_sessions_user";

/**
 * Deliberately not tight. The caller is someone who thinks they have been
 * compromised and may well press the button twice — and the control is bounded
 * by construction anyway, since a successful call destroys the credential needed
 * to make the next one. What this really bounds is a caller holding a STOLEN
 * token trying to be a nuisance, and the damage there is capped at "the victim
 * is signed out", which is also what the victim would have chosen.
 */
export const REVOKE_SESSIONS_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 20,
  maxPerDay: 40,
};

/**
 * Why the revocation did not happen.
 *
 * `rate_limited` is separated from `failed` because the two deserve different
 * HTTP statuses and different words: 429 and "esperá un momento" against 503 and
 * "cambiá tu contraseña". Collapsing them would have the API answer 503 to a
 * throttle — telling a client the platform is broken when it is working exactly
 * as designed.
 */
export type RevokeSessionsFailureReason = "rate_limited" | "failed";

export type RevokeSessionsResult =
  | { ok: true }
  | { ok: false; reason: RevokeSessionsFailureReason; error: string };

export type RevokeSessionsInput = {
  /** The caller's own validated access token. Authorizes the whole operation. */
  accessToken: string;
  /** The caller, for the audit row. Resolved by the guard, never from the token. */
  userId: string;
  /** Which surface asked, so the trail can tell the web button from the app. */
  surface: "web" | "api_v1";
};

/** es-AR copy for a revocation that did not go through. */
const REVOKE_FAILED_MESSAGE =
  "No pudimos cerrar las sesiones. Probá de nuevo en unos minutos y, si sigue fallando, cambiá tu contraseña.";

/**
 * es-AR copy for a throttled revocation. It must NOT reuse the failure message:
 * "cambiá tu contraseña" would send someone who simply pressed the button three
 * times to change a credential for no reason, and would hide that the earlier
 * press probably worked.
 */
const REVOKE_THROTTLED_MESSAGE =
  "Ya pediste cerrar las sesiones varias veces seguidas. Esperá un momento antes de volver a intentarlo.";

const failure = (reason: RevokeSessionsFailureReason, error: string): RevokeSessionsResult => ({
  ok: false,
  reason,
  error,
});

/**
 * Revoke EVERY session of the user who owns `accessToken`, including the one
 * the token belongs to.
 *
 * `accessToken` must be a token the caller has already had validated — both
 * surfaces call this only after `requireLiveUser`, which round-trips it to
 * GoTrue. This function does not re-validate: GoTrue rejects a bad token at the
 * logout endpoint anyway, so a second check here would buy nothing but a round
 * trip.
 *
 * FAILS CLOSED, unlike the rate limiters around it. A limiter that cannot answer
 * lets a request through because refusing would break an ordinary read; a
 * revocation that cannot answer must NOT report success, because the user's next
 * move depends on believing it. Someone told "listo" who was not signed out
 * anywhere will stop worrying about a device that is still logged in. The error
 * copy therefore names the fallback that does not depend on us — change the
 * password, which invalidates sessions on GoTrue's side.
 */
export async function revokeAllSessions({
  accessToken,
  userId,
  surface,
}: RevokeSessionsInput): Promise<RevokeSessionsResult> {
  if (!accessToken) return failure("failed", REVOKE_FAILED_MESSAGE);

  // ONE budget for both transports — see the header. Applied before GoTrue is
  // touched, and failing OPEN if the limiter itself cannot answer.
  try {
    await enforceRateLimit(REVOKE_SESSIONS_USER_BUCKET, userId, REVOKE_SESSIONS_USER_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return failure("rate_limited", REVOKE_THROTTLED_MESSAGE);
    reportError("revoke-sessions/rate-limit", err);
  }

  const supabase = createAnonClient();

  try {
    const { error } = await supabase.auth.admin.signOut(accessToken, "global");
    if (error) return failure("failed", REVOKE_FAILED_MESSAGE);
  } catch {
    // `admin.signOut` returns AuthErrors rather than throwing them, so reaching
    // here means the transport itself failed (DNS, TLS, a dead GoTrue). Same
    // answer: say it did not work.
    return failure("failed", REVOKE_FAILED_MESSAGE);
  }

  // AFTER the revocation, and its failure does NOT fail the call.
  //
  // Both halves of that are deliberate. Writing the row first would record a
  // revocation that may not happen; of the two ways to be wrong, "revoked but
  // unlogged" is much better than "logged but still signed in everywhere".
  //
  // And once the sessions are actually gone, reporting failure would be a lie
  // that costs the user something real: they would retry a control that already
  // worked, and doubt it. The missing row is an observability problem and is
  // reported as one.
  try {
    await writeAuditLog(db, {
      action: "sessions_revoked_self",
      actorUserId: userId,
      targetUserId: userId,
      payload: { surface },
    });
  } catch (err) {
    reportError("revoke-sessions/audit", err);
  }

  return { ok: true };
}
