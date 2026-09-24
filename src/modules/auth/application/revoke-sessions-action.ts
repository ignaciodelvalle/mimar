// The WEB entry point for B11 — "cerrar sesión en todos los dispositivos".
//
// Separate from the use-case (./revoke-sessions.ts) because the two surfaces
// share the REVOCATION and not the credential teardown. Revoking is one act; a
// browser additionally has cookies to drop, and a native client has nothing to
// drop because a bearer token lives in the app's own keychain.
//
// WHY THE SECOND signOut CALL IS NOT A SECOND REVOCATION
// ---------------------------------------------------------------------------
// After the use-case succeeds, every session for this user is gone at GoTrue —
// including this browser's. But the SSR cookies are still sitting in the
// response, now holding tokens that authenticate nobody. Left there they produce
// the confusing state where the app looks logged in until something round-trips
// and 401s.
//
// `signOut({ scope: "local" })` is what clears them. It does attempt a GoTrue
// call, which now returns 401 — and auth-js explicitly IGNORES 401/403/404 there
// ("an invalid or expired JWT should sign out the current session") and proceeds
// to `_removeSession()` regardless. So the cookies are dropped whether or not
// the call succeeds, which is the behaviour we want and the reason `local` is
// safe to use on an already-dead session.
//
// It is `local` rather than `global` deliberately: global would ask GoTrue to
// revoke everything a second time, which is a wasted round-trip whose failure
// would be indistinguishable from the real revocation failing.
//
// RATE LIMITING: THIS FILE HAS NONE, AND THAT IS NOW CORRECT (2026-08-25)
// ---------------------------------------------------------------------------
// It had none before either, and that was NOT correct. The `/api/v1` sibling
// spent a per-user budget and its header argued at length why the bound is
// needed; this surface, calling the same use-case, was the way around it — so
// the ceiling was a property of the transport rather than of the identity, and a
// caller holding a stolen cookie simply used the button.
//
// The budget now lives in the use-case (`REVOKE_SESSIONS_USER_BUCKET`,
// 5/min · 20/hr · 40/day, keyed on the user id), which both surfaces call. Adding
// a second limiter here would double-count the same act and halve the real
// ceiling for anyone using the browser.
//
// The refusal comes back as `reason: "rate_limited"` with its own es-AR copy —
// "esperá un momento", never the revocation-failed message, which tells people
// to change their password and would send someone who merely pressed twice to do
// it for nothing.

import { requireLiveUser } from "@/lib/infra/live-user";
import { reportError } from "@/lib/infra/report-error";
import {
  type RevokeSessionsResult,
  revokeAllSessions,
} from "@/src/modules/auth/application/revoke-sessions";

/**
 * Revoke every session of the signed-in user, then drop this browser's cookies.
 *
 * Returns a result rather than redirecting. The caller is a client component in
 * a dialog: it needs to render an error in place when this fails, and to perform
 * a FULL document navigation when it succeeds. A `redirect()` from a Server
 * Action resolves and is then dropped by the client router (contract N3), so
 * redirecting here would leave the dialog open over a dead session.
 *
 * @no-auth-required — the marker is about the SCANNER, not about the policy.
 * This function calls requireLiveUser in its own body and that call IS the
 * authorization; it is the first statement and it fails closed.
 */
export async function revokeAllSessionsAction(): Promise<RevokeSessionsResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { ok: false, reason: "failed", error: live.error };

  // The token this browser is holding — the one the revocation authorizes with.
  // `getSession()` does not re-validate, and does not need to: requireLiveUser
  // has just had GoTrue accept the same cookie. Only `access_token` is read.
  const { data } = await live.supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    // requireLiveUser said there is a session and the cookie says otherwise.
    // Refuse rather than guess: this is a security control, and the one thing it
    // may never do is report a revocation it did not perform.
    reportError(
      "revoke-sessions/web",
      new Error("requireLiveUser resolved a user but no access token was readable"),
    );
    return {
      ok: false,
      reason: "failed",
      error: "No pudimos leer tu sesión. Cerrá sesión y volvé a entrar.",
    };
  }

  const result = await revokeAllSessions({ accessToken, userId: live.user.id, surface: "web" });
  if (!result.ok) return result;

  // Cookies only — see the header. Never allowed to turn a completed revocation
  // into a reported failure: the sessions are already gone, and telling the user
  // otherwise would send them chasing a control that worked.
  try {
    await live.supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    reportError("revoke-sessions/web-cookie-clear", err);
  }

  return { ok: true };
}
