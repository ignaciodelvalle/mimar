// Mail an institutional account its first-access link (pilot T1-P3).
//
// WHY THIS IS NOT GOTRUE'S OWN INVITE MAIL ANY MORE
// ---------------------------------------------------------------------------
// The account used to be created UNCONFIRMED so `inviteUserByEmail` would mail
// it. With signup open and autoconfirm on (PO D2), an unconfirmed address is
// an open door: anybody who knows or guesses the operator's address can call
// the public `signUp({ email, password })` before the invitee opens the mail,
// and GoTrue then sets THEIR password on the existing user and confirms it —
// an attacker holding a govt/admin/national account. So the account is now
// born CONFIRMED (a public signup gets "already registered"), and GoTrue no
// longer mails an invite to a confirmed address.
//
// The two GoTrue mails that DO reach a confirmed address do not fit either:
// the hosted recovery template carries only the six-digit code (PO decision
// 2026-09-13), not a link to /primer-acceso, and the magic-link template's
// content is not something this repo can see. So the link is generated with
// the admin API and delivered through the repo's own mail path — Resend, the
// same sender the denuncia access link and the analytics export use.
//
// NEVER LOGS THE LINK. It is a credential for an institutional account; the
// denuncia helper logs its link when Resend is unset, this one must not. A
// mail that cannot go out returns false, and the admin panel then shows the
// link to forward by hand (that surface is already built for it).

import { resolveMailSender } from "@/lib/infra/outbound-channels";
import { escapeHtml } from "@/lib/utils/escape-html";

export async function mailInstitutionalAccessLink(input: {
  to: string;
  displayName: string;
  actionLink: string;
}): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return false;
  try {
    const { Resend } = await import("resend");
    const { error } = await new Resend(apiKey).emails.send({
      from: resolveMailSender(process.env),
      to: input.to,
      subject: "Tu cuenta institucional en miMAR",
      html: `
        <p>Hola ${escapeHtml(input.displayName)}:</p>
        <p>Un administrador de miMAR te creó una cuenta institucional.</p>
        <p><a href="${escapeHtml(input.actionLink)}">Entrar y elegir mi contraseña</a></p>
        <p>El link sirve una sola vez y vence. Si no esperabas este mail, no abras el link.</p>
      `,
    });
    if (error) {
      console.error("institutional access mail refused by the provider (account exists)", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("institutional access mail threw (account exists)", e);
    return false;
  }
}
