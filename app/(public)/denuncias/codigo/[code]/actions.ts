"use server";

// Second factor for the reporter view — "sin cuenta ≠ sin autenticación".
//
// The reference code identifies a denuncia. It must not also authenticate one,
// because it is designed to be written on a scrap of paper and it says nothing
// about who is holding it. This action adds the missing factor: control of the
// contact channel the reporter themselves left on the record.
//
// It never confirms anything. Same message on every branch — code absent, code
// present with no email on file, code present with a DIFFERENT email, code
// present with a matching email. A caller learns nothing from the response, so
// the action cannot be turned into an oracle for "does DEN-XXXX exist" or "is
// this the reporter's address". This is why the neutral string is a module
// constant returned from a single place rather than repeated per branch: a
// future edit cannot accidentally make one branch distinguishable.
//
// THE RESPONSE BODY IS NOT THE ONLY CHANNEL — the clock is one too.
// This action used to `await sendAccessLink(...)`, and that await ran on
// exactly ONE branch: the full match. Every other branch returned without
// touching the network. The string was identical and the LATENCY was not, so
// the endpoint stayed an oracle through a side door: hold a reference code,
// submit a handful of suspected addresses, and the one that takes an extra
// network round trip is the reporter's. Precisely what unpublishing the
// denuncia page exists to prevent, and against precisely the person it exists
// to protect the reporter from.
//
// The mail is therefore SCHEDULED, not awaited: `after()` runs it once the
// response is already on its way out, so every branch returns after the same
// local work (one indexed lookup, and on the matching branch an HMAC). The
// remaining differences are microseconds of CPU, not a network hop.
//
// A note for whoever adds the next channel here: do not await it either. The
// property this file needs is that NOTHING observable from outside varies with
// which branch was taken — response body, status, and time to respond alike.

import { db, welfareReports } from "@/db";
import { generateReporterToken, reporterAccessRevoked } from "@/lib/infra/denuncia-reporter-token";
import { resolveMailSender } from "@/lib/infra/outbound-channels";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import {
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "@/src/modules/welfare/domain/reference-code";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { after } from "next/server";

export type SolicitarAccesoState = { message: string | null; throttled?: boolean };

// One message, every outcome. Also carries the honest limitation: a reporter who
// left only a phone, or none at all, has no channel we can deliver to today, and
// must be told that instead of being left refreshing an inbox.
const NEUTRAL_MESSAGE =
  "Si dejaste un email al hacer la denuncia, te enviamos un enlace de acceso. Revisá tu correo — el enlace vence en 30 minutos. Si dejaste solo un teléfono, o enviaste la denuncia de forma anónima, no podemos verificar tu identidad por este medio: escribile al organismo con tu código de constancia.";

const THROTTLED_MESSAGE =
  "Demasiados intentos desde esta conexión. Esperá unos minutos y volvé a intentarlo.";

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// @no-auth-required: this action IS the authentication step for a reporter who
// has no account by design (a person may denounce cruelty without registering),
// so there is no session to guard. What stands in for a guard: a tight per-IP
// rate limit (5/min, 20/hour), a reference-code format check, an exact match
// against the contact already on the record, and a single neutral response on
// every branch so the endpoint cannot be used as an existence oracle. It grants
// nothing directly — it only mails a 30-minute capability to an address the
// reporter themselves put on file.
export async function solicitarAccesoDenunciaAction(
  _prev: SolicitarAccesoState,
  formData: FormData,
): Promise<SolicitarAccesoState> {
  const code = normalizeReferenceCode(String(formData.get("code") ?? ""));
  const email = normalizeEmail(String(formData.get("email") ?? ""));

  // Tighter than the page's read limit: this endpoint mints capabilities and
  // sends mail. 5/min caps an online guessing attempt against the (code, email)
  // pair, and 20/hour caps using a victim's inbox as a mail-flood target.
  try {
    const reqHeaders = await headers();
    await enforceRateLimit("denuncia_access_request", callerIp(reqHeaders), {
      maxPerMinute: 5,
      maxPerHour: 20,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return { message: THROTTLED_MESSAGE, throttled: true };
    throw err;
  }

  // Everything below is best-effort and silent. Any failure — bad format,
  // unknown code, wrong email, unconfigured mailer — returns NEUTRAL_MESSAGE.
  try {
    if (!isValidReferenceCodeFormat(code) || email.length === 0)
      return { message: NEUTRAL_MESSAGE };

    const [report] = await db
      .select({
        id: welfareReports.id,
        reporterContactEmail: welfareReports.reporterContactEmail,
        closedAt: welfareReports.closedAt,
      })
      .from(welfareReports)
      .where(eq(welfareReports.referenceCode, code))
      .limit(1);

    if (!report) return { message: NEUTRAL_MESSAGE };
    // A closed-and-aged denuncia is past its access window; minting a link into
    // it would be a capability the seguimiento page will refuse anyway.
    if (reporterAccessRevoked(report.closedAt)) return { message: NEUTRAL_MESSAGE };

    const onFile = normalizeEmail(report.reporterContactEmail);
    if (onFile.length === 0 || onFile !== email) return { message: NEUTRAL_MESSAGE };

    const token = generateReporterToken("access_link", report.id);
    const url = `${resolveSiteUrl()}/denuncias/seguimiento/entrar?r=${encodeURIComponent(report.id)}&t=${encodeURIComponent(token)}`;

    // Scheduled, never awaited — see the timing note in the header. The
    // callback runs after the response is flushed, so it owns its own error
    // handling: the try/catch around this block has already returned by then.
    after(async () => {
      try {
        await sendAccessLink(onFile, code, url);
      } catch (err) {
        console.error("[denuncias] deferred access-link send failed:", err);
      }
    });
  } catch (err) {
    // Swallowed on purpose: an error string here would be a side channel.
    console.error("[denuncias] solicitarAccesoDenunciaAction failed (non-fatal):", err);
  }

  return { message: NEUTRAL_MESSAGE };
}

/**
 * Deliver the link. Email is the only channel this product can actually reach a
 * reporter on: `lib/infra/web-push.ts` needs a registered browser subscription
 * (an anonymous reporter has none) and there is NO app-level SMS sender — the
 * Twilio block in supabase/config.toml belongs to Supabase Auth's own OTP, not
 * to us. When RESEND_API_KEY is unset (local dev, CI) the link is logged instead
 * of sent, mirroring app/gob/analytics/export/actions.ts, so the flow stays
 * testable without a mail account.
 *
 * The mail body deliberately contains NO detail about the denuncia beyond the
 * constancia code the reporter already holds: an inbox is a surface we do not
 * control, and it is read on lock screens.
 */
async function sendAccessLink(to: string, code: string, url: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[denuncias] RESEND_API_KEY not set — access link for ${code}: ${url}`);
    return;
  }
  const { Resend } = await import("resend");
  const { error } = await new Resend(apiKey).emails.send({
    from: resolveMailSender(process.env),
    to,
    subject: `Acceso al seguimiento de tu denuncia ${code}`,
    html: `
      <p>Pediste acceso al seguimiento de tu denuncia <strong>${code}</strong>.</p>
      <p><a href="${url}">Ver el estado de mi denuncia</a></p>
      <p>El enlace vence en 30 minutos y sirve una sola vez por sesión. Si no pediste esto, ignorá este mensaje.</p>
    `,
  });
  if (error) console.warn("[denuncias] Resend error sending access link:", error);
}
