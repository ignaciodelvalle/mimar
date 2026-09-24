// Use-case: updatePasswordAction — re-verifies that the session IS a recovery
// session (amr proof, A04-1), validates password strength, then calls
// supabase.auth.updateUser({ password }).
//
// Runs inside a valid recovery session — and, since A04-1, ONLY inside one: an
// ordinary signed-in session is refused (see recovery-proof.ts). Since 2026-09-15 that session comes from
// the LEGACY RECOVERY LINK and only from it (mail link → /auth/callback →
// /recuperar/actualizar): the six-digit code no longer lands here, because
// `ResetCodeStep` redeems it and sets the password in the same submit, so no
// step exists between the two for anybody to abandon. This route stays because a
// mail client, a forwarded message or an edited template can still deliver a
// link and no code, and a person holding one has no other way through.
//
// The page verifies the session AND its recovery proof before rendering the
// form; this action re-verifies both to prevent direct POST abuse. Changing the
// password from inside the account is a different act with a different proof —
// the current password — and lives in ../change-password.ts.

import { authMethodReferences, verifiedSessionClaims } from "@/lib/infra/verified-token-claims";
import { createClient } from "@/lib/supabase/server";
import {
  PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE,
  isPasswordSetupPending,
} from "@/src/modules/auth/domain/first-access";
import {
  MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE,
  isInsufficientAalError,
} from "@/src/modules/auth/domain/mfa-policy";
import { validateNewPassword } from "@/src/modules/auth/domain/new-password-rules";
import { hasFreshRecoveryProof } from "@/src/modules/auth/domain/recovery-proof";

import { revokeOtherSessions } from "./revoke-other-sessions";
import type { UpdatePasswordState } from "./types";

const RECOVERY_SESSION_INVALID =
  "Tu sesión de recuperación expiró o no es válida. Pedí un código nuevo desde la página de recuperación.";

export async function updatePasswordAction(
  _previous: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const supabase = await createClient();

  // Verify a valid session exists. getUser() contacts GoTrue and is not
  // spoofable via cookie tampering — it is the authoritative check.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { error: RECOVERY_SESSION_INVALID };
  }

  // A04-1: a live session is NOT enough. This form sets a password without the
  // current one, so the session must have been minted by the recovery mail, and
  // recently — see recovery-proof.ts. Any other session (an ordinary sign-in, a
  // borrowed laptop) is refused and pointed back at the recovery page. The token
  // read here is the one getUser() just validated; an unreadable one fails
  // CLOSED.
  const claims = await verifiedSessionClaims(supabase);
  if (!hasFreshRecoveryProof(authMethodReferences(claims))) {
    return { error: RECOVERY_SESSION_INVALID };
  }

  // A first-access link session carries `otp` too; an account that still owes
  // its first password pays it at /primer-acceso only (first-access.ts).
  if (isPasswordSetupPending(user)) return { error: PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE };

  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  // The same two rules `ResetCodeStep` applies in the browser and the phone
  // applies in `resetPasswordWithCode`, from the one module that owns them —
  // see `new-password-rules.ts` for why they stopped living here.
  const passwordProblem = validateNewPassword(password, confirmPassword);
  if (passwordProblem) return { error: passwordProblem };

  const { error } = await supabase.auth.updateUser({ password });

  // An account with a verified second factor cannot set its password from a
  // recovery session at all (aal1) — say so, and name the way that works
  // (mfa-policy.ts). Only reachable after a valid recovery, so it reveals
  // nothing about the account to somebody who does not already hold its mail.
  if (isInsufficientAalError(error)) return { error: MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE };

  // ONE sentence for every `updateUser` failure, never GoTrue's text (A04-6).
  // Its messages here are account-state-shaped ("New password should be
  // different from the old password"), and the rule `signup.ts` states for
  // itself — never the raw Supabase text — holds in this module too. The copy
  // names the two things the person can actually do.
  if (error) {
    return {
      error:
        "No se pudo actualizar la contraseña. Probá con otra contraseña o pedí un código nuevo desde la página de recuperación.",
    };
  }

  // Revoke every OTHER session (audit 28-#MED-5). Shared with the code step,
  // which reaches the same posture from the browser — see
  // `revoke-other-sessions.ts` for the scope and the best-effort reasoning.
  await revokeOtherSessions(supabase.auth);

  return { error: null, ok: true };
}
