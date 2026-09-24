// Revoke EVERY live session of an institutional account, from the admin side.
//
// WHY THIS SHAPE
// ---------------------------------------------------------------------------
// GoTrue's admin API has no "sign out user <id>". `auth.admin.signOut(jwt,
// scope)` is not that call either: its first argument is a logged-in user's
// ACCESS TOKEN, and it POSTs /logout with that token as the bearer (verified
// in auth-js 2.105.4; see src/modules/auth/application/revoke-sessions.ts).
// `scope: "global"` then ends every session of the token's user, and the
// repo measured that against local GoTrue: the old access tokens are refused
// at once (403 on /user, not "valid until exp") and the refresh tokens die.
//
// So the admin side mints one short-lived session for the target and spends
// it on a global logout:
//   1. generateLink(magiclink)  → a one-time hashed token (service role)
//   2. verifyOtp(token_hash)    → a session for the target, on a THROWAWAY
//                                 anon client that never persists it
//   3. admin.signOut(token, "global") → every session of that user, the
//                                 minted one included, is gone
//
// The rejected alternatives: deleting `auth.sessions` rows by hand (GoTrue's
// own tables, not ours to edit), and ban-then-unban (a ban refuses NEW
// sign-ins; it is not documented to end the sessions that already exist, and
// an immediate unban would make it a no-op even if it did).
//
// NEVER on the shared admin client: `verifyOtp` stores the session it returns
// on the client that called it, and createAdminClient() is a module-level
// singleton — a user session parked on it would turn later "service role"
// calls into calls AS THAT USER. Hence the throwaway client below.
//
// Fails CLOSED: any step that does not complete returns an error, and the
// caller must not issue a new access link on top of a session it could not end.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";

export async function revokeAllSessionsOf(
  admin: Pick<SupabaseClient, "auth">,
  email: string,
): Promise<{ ok: true } | { error: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { error: "SESSION_REVOKE_FAILED: missing Supabase env" };

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return { error: `SESSION_REVOKE_FAILED: ${linkErr?.message ?? "no hashed_token"}` };
  }

  const throwaway = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: verified, error: verifyErr } = await throwaway.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  const accessToken = verified?.session?.access_token;
  if (verifyErr || !accessToken) {
    return { error: `SESSION_REVOKE_FAILED: ${verifyErr?.message ?? "no session"}` };
  }

  const { error: signOutErr } = await admin.auth.admin.signOut(accessToken, "global");
  if (signOutErr) return { error: `SESSION_REVOKE_FAILED: ${signOutErr.message}` };
  return { ok: true };
}
