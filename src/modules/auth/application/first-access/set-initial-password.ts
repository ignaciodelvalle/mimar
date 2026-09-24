// Use-case: setInitialPassword — the "establecé tu contraseña" step of an
// institutional account's first access (pilot T1-P3).
//
// The session arrives from the invite mail (or the hand-copied fallback link):
// /primer-acceso turns the link into a cookie session in the browser, then the
// form posts here. See src/modules/auth/domain/first-access.ts for the flag.
//
// WHY THE FLAG IS REQUIRED, NOT JUST A SESSION. Without it this would be a
// "change your password without typing the current one" endpoint for every
// logged-in account. The flag is only ever set by the service role (account
// creation, credential reset), so only a session that came from one of those
// links can set a password here. Anybody else is told to use /recuperar.
//
// WHY THE SESSION MUST POSTDATE THE ARMING. The flag is per ACCOUNT. A
// credential reset re-arms it and then revokes every session; a session that
// survived a failed revocation would still carry the flag, and could choose the
// password the reset was meant to take from it. So only a session AUTHENTICATED
// at or after the stamped arming instant is accepted (amr timestamp, not iat —
// see isSessionAfterArming in the domain file). Anybody else is told the link
// expired, which is exactly the remedy: ask for a new one.
//
// Same password rules as every other place that sets one
// (`validateNewPassword`, src/modules/auth/domain/new-password-rules.ts).

import type { SupabaseClient } from "@supabase/supabase-js";

import { verifiedSessionStart } from "@/lib/infra/operator-shift";
import { reportError } from "@/lib/infra/report-error";
import { resolveUserLanding } from "@/lib/infra/role-landing";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  completedPasswordSetupMetadata,
  isPasswordSetupPending,
  isSessionAfterArming,
  passwordSetupArmedAt,
} from "@/src/modules/auth/domain/first-access";
import { isInsufficientAalError } from "@/src/modules/auth/domain/mfa-policy";
import { validateNewPassword } from "@/src/modules/auth/domain/new-password-rules";

export type SetInitialPasswordState = {
  error: string | null;
  ok?: boolean;
  /** Where the account's portal starts, for the success screen's button. */
  landing?: string;
};

export const FIRST_ACCESS_MESSAGES = {
  no_session:
    "El link de acceso venció o ya se usó. Pedile a quien te creó la cuenta que te envíe uno nuevo.",
  not_pending:
    "Tu cuenta ya tiene contraseña. Si no la recordás, usá “¿Olvidaste tu contraseña?” en el inicio de sesión.",
} as const;

/**
 * A GoTrue refusal while writing the password. Fixed copy: GoTrue's own message
 * is English, internal, and may describe the account's state; it is reported
 * server-side (reportError) and never shown.
 */
export const PASSWORD_NOT_SAVED_MESSAGE =
  "No se pudo guardar la contraseña. Probá de nuevo en unos minutos; si sigue fallando, pedile a quien te creó la cuenta un link nuevo.";

/**
 * @param supabase The caller's SESSION client (cookie-bound on the web; the
 *   actions layer builds it — the application layer may not reach for
 *   next/headers). Its session is the one the first-access link minted.
 */
export async function setInitialPassword(
  supabase: Pick<SupabaseClient, "auth">,
  input: { password: string; confirmPassword: string },
): Promise<SetInitialPasswordState> {
  // getUser() asks GoTrue, so both the session and the flag are the server's
  // answer — a tampered cookie or a stale token claim cannot fake either.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { error: FIRST_ACCESS_MESSAGES.no_session };
  if (!isPasswordSetupPending(user)) return { error: FIRST_ACCESS_MESSAGES.not_pending };

  // The token getUser() just had GoTrue validate — the precondition
  // verifiedSessionStart states. getSession() only reads it back.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const sessionStartedAt = verifiedSessionStart(session?.access_token);
  if (!isSessionAfterArming(sessionStartedAt, passwordSetupArmedAt(user))) {
    if (sessionStartedAt === null) {
      reportError(
        "first-access/session-start",
        new Error("First-access session carried no usable amr timestamp; refused (fails closed)."),
      );
    }
    return { error: FIRST_ACCESS_MESSAGES.no_session };
  }

  const { password, confirmPassword } = input;
  const passwordProblem = validateNewPassword(password, confirmPassword);
  if (passwordProblem) return { error: passwordProblem };

  const { error: updateError } = await supabase.auth.updateUser({ password });

  // AN ACCOUNT THAT KEEPS ITS SECOND FACTOR (2026-09-18). "Resetear
  // credenciales" re-arms this step but leaves the TOTP factor in place, and
  // GoTrue refuses to set a password from this session — a first-access link is
  // aal1 — once the account has a verified factor (`insufficient_aal`, measured
  // on local GoTrue v2.188.1). Without this branch that reset was a dead end:
  // the old password gone, the new one impossible to set. The session has just
  // proven everything this step asks for (the flag, and authentication after
  // the arming), so the password is set with the admin API, which is not
  // subject to the aal check, in the same call that clears the flag. An admin
  // password write ends the account's sessions, this one included, so the
  // person is sent to sign in with the new password (and then passes the
  // second factor they still have).
  if (isInsufficientAalError(updateError)) {
    const { error: adminError } = await createAdminClient().auth.admin.updateUserById(user.id, {
      password,
      app_metadata: completedPasswordSetupMetadata(),
    });
    if (adminError) {
      reportError("first-access/admin-password-write", adminError);
      return { error: PASSWORD_NOT_SAVED_MESSAGE };
    }
    return { error: null, ok: true, landing: "/iniciar-sesion" };
  }
  if (updateError) {
    reportError("first-access/password-write", updateError);
    return { error: PASSWORD_NOT_SAVED_MESSAGE };
  }

  // The flag lives in app_metadata, which only the service role may write.
  // If this call fails the password IS set; the person would be sent back to
  // this step on the next page and could simply set it again, so report it
  // rather than pretend the whole step failed.
  const { error: metaError } = await createAdminClient().auth.admin.updateUserById(user.id, {
    app_metadata: completedPasswordSetupMetadata(),
  });
  if (metaError) {
    console.error("first-access: password set but the pending flag was not cleared", metaError);
    return {
      error:
        "Tu contraseña quedó guardada, pero no pudimos terminar de activar la cuenta. Probá de nuevo en unos minutos.",
    };
  }

  return { error: null, ok: true, landing: await resolveUserLanding(user.id) };
}
