// "A second factor was added to your account" — the notice the account holder
// gets when a TOTP factor is enrolled through /mfa/configurar (T2-S6 hardening).
//
// WHY. Enrolment is trust on first use: whoever completes it becomes the only
// person who can pass the challenge. If that was not the holder, the holder
// must hear about it from somewhere they control, not from the session that
// just did it. The mail goes to the account's address and says what happened
// and what to do if it was not them — ask an admin to reset the second factor,
// which also resets the credentials and ends every session.
//
// WHAT IT NEVER CARRIES: the TOTP secret, the QR, the factor id, a link that
// signs anybody in. It is a notice, not a credential.
//
// DEGRADES, NEVER BLOCKS. No RESEND_API_KEY (local, preview) → a logged skip and
// `false`. A provider refusal → logged, `false`. The enrolment already happened
// at GoTrue and is audited (`mfa_factor_enrolled`); a mail outage must not turn
// it into an error the person cannot act on.

import { resolveMailSender } from "@/lib/infra/outbound-channels";
import { formatDateTime } from "@/lib/utils/format";

export const MFA_ENROLLED_MAIL_SUBJECT =
  "Se activó la verificación en dos pasos en tu cuenta de miMAR";

export function mfaEnrolledMailHtml(enrolledAt: Date): string {
  const when = formatDateTime(enrolledAt);
  return `
    <p>Hola:</p>
    <p>El ${when} (hora de Argentina) se vinculó una app de autenticación a tu cuenta institucional de miMAR. Desde ahora, para entrar se pide tu contraseña y el código de esa app.</p>
    <p>Si fuiste vos, no tenés que hacer nada.</p>
    <p><strong>Si no fuiste vos</strong>, alguien más tiene acceso a tu cuenta. Avisale hoy a una persona con rol de administración de miMAR para que restablezca tu segundo factor y tus credenciales: eso cierra todas las sesiones abiertas y te manda un link nuevo para volver a entrar.</p>
  `;
}

export async function mailMfaFactorEnrolled(input: {
  to: string;
  enrolledAt: Date;
}): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) {
    console.info("[mfa] enrolment notice skipped: RESEND_API_KEY is not configured");
    return false;
  }
  try {
    const { Resend } = await import("resend");
    const { error } = await new Resend(apiKey).emails.send({
      from: resolveMailSender(process.env),
      to: input.to,
      subject: MFA_ENROLLED_MAIL_SUBJECT,
      html: mfaEnrolledMailHtml(input.enrolledAt),
    });
    if (error) {
      console.error("[mfa] enrolment notice refused by the provider (factor is enrolled)", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[mfa] enrolment notice threw (factor is enrolled)", e);
    return false;
  }
}
