// Resend inbound webhook — the published mailboxes finally reach a person.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// MX for the owned mail domain points at Resend's inbound (SES sa-east-1), and
// Resend was receiving mail there — but nothing forwarded it anywhere. So the
// Ley 25.326 rights channel published on /privacidad (CONTACT_EMAILS.privacy)
// and the general mailbox reached nobody: the door was painted on again, one
// layer below the one lib/ui/contact.ts was written to remove.
//
// WHAT THIS DOES
// ---------------------------------------------------------------------------
// On `email.received`, re-fetch the email from Resend with the server's own API
// key, forward it to MAIL_FORWARD_TO when (and only when) one of its recipients
// is a mailbox the product publishes (lib/infra/inbound-mail.ts, derived from
// CONTACT_EMAILS), and drop everything else silently.
//
// WHY THE PAYLOAD IS NOT TRUSTED
// ---------------------------------------------------------------------------
// The only fields read from the webhook body are `type` and `data.email_id`.
// Everything the decision depends on — recipients, subject, body — comes from
// the AUTHORITATIVE re-fetch. A forged event can therefore name only an id; an
// id Resend does not know 404s and nothing happens. That is why the Svix
// signature (RESEND_WEBHOOK_SECRET) is defence in depth rather than the only
// line: without it, the worst a stranger can do is ask us to forward, to our
// own operator, a real email that was already addressed to one of our own
// published mailboxes — which is what happens anyway.
//
// WHY THERE IS NO RATE LIMIT
// ---------------------------------------------------------------------------
// Every forward is bounded by mail that genuinely arrived at an allowlisted
// mailbox (the re-fetch proves it), and each email id forwards at most once
// (per-instance guard, plus Resend's idempotency key across instances). A
// caller cannot amplify: N requests for one id produce one forward, and ids
// that are not real produce zero. Flooding the published mailboxes with real
// mail is spam — the mailbox's problem, not an amplification of this endpoint.
//
// WHY NOT `resend.emails.receiving.forward`
// ---------------------------------------------------------------------------
// The SDK helper exists (resend 6.12.3), but neither of its modes keeps the
// ORIGINAL SENDER reachable: passthrough re-sends the parsed body from our own
// `from` with no Reply-To, so the forwarded copy does not even say who wrote,
// and "wrapped" buries the sender in an attachment. A rights request whose
// author the operator cannot answer is not delivered in any sense that
// matters. So this route builds the send itself: the original text/html,
// Reply-To set to the original sender, and the original message attached as
// .eml (attachments and headers survive there).
//
// PRIVACY OF THE LOGS
// ---------------------------------------------------------------------------
// Log lines carry the email id, the matched mailbox KEY (general/privacy/
// pilots) and the outcome. Never a sender, a recipient, a subject or a body:
// the whole point of the privacy mailbox is that what is written to it is
// read by a person, not by whoever reads the function logs.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { CreateEmailOptions, GetReceivingEmailResponseSuccess } from "resend";
import { Resend } from "resend";

import {
  FORWARD_SENDER,
  alreadyHandled,
  isOnInboundDomain,
  markHandled,
  matchPublishedMailbox,
  normalizeMailbox,
  releaseHandled,
  shouldWarnUnsigned,
} from "@/lib/infra/inbound-mail";
import { reportError } from "@/lib/infra/report-error";
import { CONTACT_EMAILS, type ContactMailboxKey } from "@/lib/ui/contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_CONTEXT = "webhooks/resend-inbound";

/** How long the raw-message download may take before it counts as transient. */
const RAW_DOWNLOAD_TIMEOUT_MS = 10_000;

type Outcome =
  | "ignored-type"
  | "bad-payload"
  | "not-found"
  | "dropped-unlisted"
  | "duplicate"
  | "forwarded"
  | "misconfigured"
  | "rejected"
  | "transient";

/** One structured line, ids and outcome only. NEVER an address or a subject. */
function logOutcome(outcome: Outcome, emailId: string | null, mailbox?: ContactMailboxKey): void {
  console.info(
    JSON.stringify({
      level: "info",
      context: LOG_CONTEXT,
      outcome,
      emailId,
      ...(mailbox ? { mailbox } : {}),
      ts: new Date().toISOString(),
    }),
  );
}

function ok(): NextResponse {
  return NextResponse.json({ ok: true }, { status: 200 });
}

function retryLater(status: 502 | 503): NextResponse {
  return NextResponse.json({ ok: false }, { status });
}

/** 429, 5xx, or no status at all (a network failure inside the SDK): worth a retry. */
function isTransient(statusCode: number | null | undefined): boolean {
  return statusCode === null || statusCode === undefined || statusCode === 429 || statusCode >= 500;
}

/** Reads `type` and `data.email_id` and nothing else from the untrusted body. */
function readEvent(body: unknown): { type: unknown; emailId: string | null } {
  if (typeof body !== "object" || body === null) return { type: undefined, emailId: null };
  const { type, data } = body as { type?: unknown; data?: unknown };
  const emailId =
    typeof data === "object" && data !== null
      ? (data as { email_id?: unknown }).email_id
      : undefined;
  return {
    type,
    emailId: typeof emailId === "string" && emailId.trim().length > 0 ? emailId.trim() : null,
  };
}

/**
 * Builds the forward. Null when the raw message could not be downloaded — a
 * transient condition (the signed URL is fresh on the next re-fetch).
 */
async function buildForward(
  email: GetReceivingEmailResponseSuccess,
  mailbox: ContactMailboxKey,
  to: string,
): Promise<CreateEmailOptions | null> {
  const attachments: { filename: string; content: string; contentType: string }[] = [];
  if (email.raw?.download_url) {
    try {
      const res = await fetch(email.raw.download_url, {
        signal: AbortSignal.timeout(RAW_DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      attachments.push({
        filename: "mensaje-original.eml",
        content: Buffer.from(await res.arrayBuffer()).toString("base64"),
        contentType: "message/rfc822",
      });
    } catch {
      return null;
    }
  }
  const tag = CONTACT_EMAILS[mailbox].split("@")[0];
  const base = {
    from: FORWARD_SENDER,
    to: [to],
    replyTo: email.reply_to && email.reply_to.length > 0 ? email.reply_to : [email.from],
    subject: `[${tag}] ${email.subject || "(sin asunto)"}`,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  if (email.html) {
    return { ...base, html: email.html, ...(email.text ? { text: email.text } : {}) };
  }
  return { ...base, text: email.text ?? "(El mensaje original no tiene cuerpo.)" };
}

/**
 * Svix signature check. True when the request may proceed: either the secret
 * is set and the signature verifies, or the secret is unset (warned once).
 */
function signatureAccepted(req: NextRequest, raw: string, resend: Resend): boolean {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  if (secret.length === 0) {
    if (shouldWarnUnsigned()) {
      console.warn(
        JSON.stringify({
          level: "warn",
          context: LOG_CONTEXT,
          message:
            "RESEND_WEBHOOK_SECRET is not set; signatures are not verified (the authoritative re-fetch still applies)",
          ts: new Date().toISOString(),
        }),
      );
    }
    return true;
  }
  try {
    resend.webhooks.verify({
      payload: raw,
      headers: {
        id: req.headers.get("svix-id") ?? "",
        timestamp: req.headers.get("svix-timestamp") ?? "",
        signature: req.headers.get("svix-signature") ?? "",
      },
      webhookSecret: secret,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The configured forward destination, or null (reported) when it is unset or
 * would loop back into the inbound domain. Null answers 200, not 5xx: Resend
 * would retry a misconfiguration forever, and the email stays readable in
 * Resend's receiving log until the variable is fixed.
 */
function resolveForwardTo(emailId: string, mailbox: ContactMailboxKey): string | null {
  const forwardTo = (process.env.MAIL_FORWARD_TO ?? "").trim();
  const normalized = forwardTo.length > 0 ? normalizeMailbox(forwardTo) : null;
  if (normalized === null) {
    reportError(
      LOG_CONTEXT,
      new Error("MAIL_FORWARD_TO is not set; inbound mail is not forwarded"),
      { emailId, mailbox },
    );
    return null;
  }
  if (isOnInboundDomain(normalized)) {
    reportError(
      LOG_CONTEXT,
      new Error("MAIL_FORWARD_TO is on the inbound domain itself; refusing to loop"),
      { emailId, mailbox },
    );
    return null;
  }
  return forwardTo;
}

/** Builds and sends the forward, mapping every result to the webhook's answer. */
async function sendForward(
  resend: Resend,
  email: GetReceivingEmailResponseSuccess,
  emailId: string,
  mailbox: ContactMailboxKey,
  forwardTo: string,
): Promise<NextResponse> {
  // Claimed BEFORE the first await, so a concurrent redelivery of the same id
  // on this instance reads as a duplicate instead of racing to a second send.
  markHandled(emailId, "inflight");
  try {
    const forward = await buildForward(email, mailbox, forwardTo);
    if (forward === null) {
      releaseHandled(emailId);
      logOutcome("transient", emailId, mailbox);
      return retryLater(502);
    }
    const sent = await resend.emails.send(forward, {
      idempotencyKey: `inbound-forward/${emailId}`,
    });
    if (sent.error && isTransient(sent.error.statusCode)) {
      releaseHandled(emailId);
      logOutcome("transient", emailId, mailbox);
      return retryLater(502);
    }
    markHandled(emailId, "done");
    if (sent.error) {
      // A 4xx fails identically on every retry (oversized message, rejected
      // sender): report it once and stop. The email stays readable in Resend.
      reportError(LOG_CONTEXT, new Error(`forward rejected: ${sent.error.name}`), {
        emailId,
        mailbox,
        statusCode: sent.error.statusCode,
      });
      logOutcome("misconfigured", emailId, mailbox);
      return ok();
    }
    logOutcome("forwarded", emailId, mailbox);
    return ok();
  } catch (err) {
    releaseHandled(emailId);
    // The error's NAME only: an SDK message may echo request fields.
    reportError(LOG_CONTEXT, new Error(err instanceof Error ? err.name : "forward threw"), {
      emailId,
      mailbox,
    });
    logOutcome("transient", emailId, mailbox);
    return retryLater(502);
  }
}

// @no-auth-required: Resend lo llama desde afuera, sin sesión, y no hay usuario
// al que autorizar. La confianza no sale del pedido: si RESEND_WEBHOOK_SECRET
// está, la firma Svix se verifica y un fallo es 401; y en todos los casos del
// cuerpo se lee solo `type` y `data.email_id`, y el correo se vuelve a pedir a
// Resend con nuestra propia clave. Un id inventado da 404 y no pasa nada; un id
// real solo se reenvía si iba dirigido a una casilla publicada, y a un único
// destino fijo por configuración. No devuelve datos: siempre `{ ok }`.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();

  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (apiKey.length === 0) {
    // Nothing can be fetched or sent. A retry does not cure a missing key, and
    // the mail itself stays in Resend's receiving log, so answer 200.
    reportError(LOG_CONTEXT, new Error("RESEND_API_KEY is not set; inbound mail is not forwarded"));
    logOutcome("misconfigured", null);
    return ok();
  }
  const resend = new Resend(apiKey);

  if (!signatureAccepted(req, raw, resend)) {
    logOutcome("rejected", null);
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    logOutcome("bad-payload", null);
    return ok();
  }

  const { type, emailId } = readEvent(body);
  if (type !== "email.received") {
    logOutcome("ignored-type", null);
    return ok();
  }
  if (emailId === null) {
    logOutcome("bad-payload", null);
    return ok();
  }
  if (alreadyHandled(emailId)) {
    logOutcome("duplicate", emailId);
    return ok();
  }

  const fetched = await resend.emails.receiving.get(emailId);
  if (fetched.error || !fetched.data) {
    if (isTransient(fetched.error?.statusCode)) {
      logOutcome("transient", emailId);
      return retryLater(503);
    }
    logOutcome("not-found", emailId);
    return ok();
  }
  const email = fetched.data;

  const mailbox = matchPublishedMailbox([...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]);
  if (mailbox === null) {
    logOutcome("dropped-unlisted", emailId);
    return ok();
  }

  const forwardTo = resolveForwardTo(emailId, mailbox);
  if (forwardTo === null) {
    logOutcome("misconfigured", emailId, mailbox);
    return ok();
  }

  return sendForward(resend, email, emailId, mailbox, forwardTo);
}
