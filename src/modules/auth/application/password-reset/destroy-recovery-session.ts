// `destroyRecoverySession` — kill the session `verifyOtp` just minted, for real.
//
// WHY THIS MODULE EXISTS AND `auth.signOut()` ALONE DOES NOT DO THE JOB
// ---------------------------------------------------------------------------
// `ResetCodeStep` redeems the six-digit code and sets the new password in one
// handler. If `updateUser` fails, the recovery session must not survive: the
// password did not change, so a live session is exactly the window the one-screen
// design exists to close.
//
// The obvious `await auth.signOut({ scope: "local" }).catch(() => undefined)` does
// NOT deliver that, and the reason is worth writing down because it reads as
// correct. In `@supabase/auth-js`, `GoTrueClient._signOut` calls the ADMIN
// endpoint first and only then clears local storage:
//
//   const { error } = await this.admin.signOut(accessToken, scope);
//   if (error) { if (!(404 || 401 || 403 || sessionMissing)) return { error }; }
//   if (scope !== "others") { await this._removeSession(); … }
//
// So a network failure returns early and NEVER reaches `_removeSession()`. And
// `GoTrueAdminApi.signOut` wraps a failed fetch into a RETURNED
// `AuthRetryableFetchError`, not a throw — so `.catch()` never fires. The error
// is in the return value, and the return value was being discarded.
//
// THE FAILURES ARE CORRELATED, which is what turns this from a corner case into
// the common one: the most likely reason `updateUser` just failed is the same
// outage that is about to make `signOut` fail. The error branch would have left a
// live session behind on most of the occasions it ran.
//
// SO THE LOCAL CLEAR IS MADE UNCONDITIONAL. One retry for the ordinary blip, then
// a direct expiry of the auth cookies — which needs no network and therefore
// cannot fail the same way. `@supabase/ssr`'s browser client stores the session in
// cookies named `sb-<project-ref>-auth-token`, chunked as `…auth-token.0`,
// `…auth-token.1` when long, so the fallback matches on the shape rather than on
// one exact name.
//
// This module is bundled into the BROWSER. It must stay free of server imports,
// and it touches `document` only inside the fallback, guarded.

/** The narrow slice of `auth` this needs — see `revoke-other-sessions.ts`. */
type SignsOutLocally = {
  signOut: (options: { scope: "local" }) => Promise<{ error: unknown } | null | undefined>;
};

/** A Supabase auth-token cookie, chunk suffix included. */
const AUTH_COOKIE_PATTERN = /^sb-.*-auth-token(\.\d+)?$/;

/**
 * Expire every Supabase auth cookie this document can see. Synchronous and
 * offline — this is the step that makes the guarantee, so it must not depend on
 * anything that can be unreachable.
 *
 * Returns whether the document ended up with no auth cookie left. A `false` here
 * means the browser refused the write (cookies disabled entirely), in which case
 * there was no cookie jar holding a session either.
 */
function expireAuthCookies(): boolean {
  if (typeof document === "undefined") return false;

  const names = document.cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim() ?? "")
    .filter((name) => AUTH_COOKIE_PATTERN.test(name));

  for (const name of names) {
    // Both `path=/` and the bare form: a cookie is identified by name AND path,
    // and writing only one of them can leave the other alive.
    document.cookie = `${name}=; Max-Age=0; path=/`;
    document.cookie = `${name}=; Max-Age=0`;
  }

  return !document.cookie
    .split(";")
    .some((pair) => AUTH_COOKIE_PATTERN.test(pair.split("=")[0]?.trim() ?? ""));
}

/**
 * Destroy the recovery session. Resolves `true` when the browser is known to be
 * holding no session any more.
 *
 * Never throws: the caller is already on an error path and needs to render a
 * sentence, not handle a second failure.
 */
export async function destroyRecoverySession(auth: SignsOutLocally): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await auth
      .signOut({ scope: "local" })
      .catch((thrown: unknown) => ({ error: thrown }));
    // The RETURNED error is the signal, not an exception. See the header.
    if (!result?.error) return true;
  }

  const cleared = expireAuthCookies();
  if (!cleared) {
    console.warn("[password-reset] Could not clear the recovery session cookies.");
  }
  return cleared;
}
