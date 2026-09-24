// Use-case: changePasswordAction — a signed-in person changes their password
// from /cuenta, PROVING the current one (A04-1).
//
// WHY A SECOND DOOR AND NOT A WIDER FIRST ONE. `updatePasswordAction` sets a
// password with no current one, which is sound only for a session the recovery
// mail minted (recovery-proof.ts). An ordinary session proves nothing about who
// is at the keyboard now — a borrowed laptop, a session left open — so from
// inside the account the proof is the password itself.
//
// HOW THE PROOF IS CHECKED WITHOUT TOUCHING THE PERSON'S SESSION. A throwaway
// credential-free client (lib/supabase/anon.ts: no storage, no refresh) signs in
// with the account's OWN address — GoTrue's, never a typed one — and the typed
// current password. The cookie session is never replaced. The new password is
// then set THROUGH that throwaway session, and the choice is load-bearing: with
// the hosted "Secure password change" setting ON (PO, rumbo-al-piloto §7), GoTrue
// refuses a password update from a session older than 24h without a
// reauthentication nonce. The throwaway session is seconds old, so the change
// works for a person who has been signed in for a week, and GoTrue's own guard
// stays on for anybody calling /auth/v1/user directly with a stolen token.
//
// BUDGET. The current-password check is a password oracle, so it spends the
// SAME per-account bucket the login form spends (`auth_login_email`): this door
// adds no guesses to the ones the login already allows. Spent before GoTrue so
// failed attempts count.
//
// AFTERWARDS every other session dies (scope "others", the MED-5 posture shared
// with the recovery path), which also ends the throwaway one. The person keeps
// the session they are using.

import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, emailRateLimitKey, enforceRateLimit } from "@/lib/infra/rate-limit";
import { createAnonClient } from "@/lib/supabase/anon";
import {
  MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE,
  isInsufficientAalError,
} from "@/src/modules/auth/domain/mfa-policy";
import { validateNewPassword } from "@/src/modules/auth/domain/new-password-rules";

import { LOGIN_EMAIL_LIMIT } from "../login-limits";
import { revokeOtherSessions } from "./revoke-other-sessions";
import type { UpdatePasswordState } from "./types";

const WRONG_CURRENT_PASSWORD = "La contraseña actual no es correcta.";
const TOO_MANY_ATTEMPTS = "Demasiados intentos. Esperá un momento y volvé a probar.";
const UPDATE_FAILED =
  "No se pudo cambiar la contraseña. Probá con otra contraseña distinta de la actual.";

export async function changePasswordAction(
  _previous: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };

  // GoTrue's record of the address, from the token getUser() just validated.
  const email = live.user.email;
  if (!email) return { error: UPDATE_FAILED };

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!currentPassword) return { error: "Ingresá tu contraseña actual." };

  const passwordProblem = validateNewPassword(password, confirmPassword);
  if (passwordProblem) return { error: passwordProblem };

  try {
    await enforceRateLimit("auth_login_email", emailRateLimitKey(email), LOGIN_EMAIL_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return { error: TOO_MANY_ATTEMPTS };
    throw err;
  }

  const throwaway = createAnonClient();
  const { data: proof, error: proofError } = await throwaway.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  // The proof must name THIS account. GoTrue's contract says an error-free
  // sign-in always carries a user; the id comparison is what makes "the current
  // password of somebody else" impossible to launder through here.
  if (proofError || !proof.user || proof.user.id !== live.user.id) {
    return { error: WRONG_CURRENT_PASSWORD };
  }

  const { error: updateError } = await throwaway.auth.updateUser({ password });
  if (updateError) {
    // Best-effort cleanup of the proof session; revokeOtherSessions below does
    // not run on this branch.
    await throwaway.auth.signOut({ scope: "local" }).catch(() => undefined);
    // The proof session is a fresh PASSWORD sign-in, i.e. aal1, and GoTrue will
    // not set a password from aal1 on an account with a verified factor.
    if (isInsufficientAalError(updateError)) {
      return { error: MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE };
    }
    // One sentence, never GoTrue's text (A04-6).
    return { error: UPDATE_FAILED };
  }

  // Every session but the one the person is holding — the throwaway included.
  await revokeOtherSessions(live.supabase.auth);

  return { error: null, ok: true };
}
