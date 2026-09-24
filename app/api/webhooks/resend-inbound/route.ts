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
// id Resend does not know 404s and nothing is forwarded.
//
// That does NOT make the signature optional in production. Every forged id
// still costs one call against the Resend API rate limit, and that limit is
// SHARED with signup confirmation and password-reset mail: an unsigned
// endpoint is a lever anyone can pull to starve those. So with no
// RESEND_WEBHOOK_SECRET and VERCEL_ENV=production the route fails CLOSED
// (401, before any Resend call). Elsewhere it warns once and proceeds, which
// keeps preview and local testable.
//
// The body is capped BEFORE it is read (MAX_WEBHOOK_BODY_BYTES): a webhook
// event is a few hundred bytes, and an uncapped `req.text()` lets a stranger
// make the function buffer whatever they send.
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
// matters. So this route builds the send itself.
//
// WHY THE FORWARD IS PLAIN TEXT WE WROTE
// ---------------------------------------------------------------------------
// The forward leaves from OUR domain, DKIM-aligned. Re-sending a stranger's
// HTML inside it would launder a phishing page into a message the operator's
// mail client trusts as ours (the Resend receiving log already holds a fake
// "tribunal" notice). So the body is plain text generated here: a banner that
// names the mailbox and the original sender and says to verify before
// clicking, then the original TEXT part, truncated. The original HTML exists
// only inside the attached .eml, where the client presents it as a foreign
// message. Reply-To is the original sender, so answering still works.
//
// The .eml is capped (MAX_EML_BYTES, headroom for base64 under Resend's send
// limit). An oversized original, or one Resend refuses as an attachment, is
// forwarded WITHOUT it, and the text says so and where to find it.
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
  isForwardSender,
  isOnInboundDomain,
  markHandled,
  matchPublishedMailbox,
  normalizeMailbox,
  releaseHandled,
  sanitizeHeaderText,
  shouldWarnUnsigned,
} from "@/lib/infra/inbound-mail";
import { reportError } from "@/lib/infra/report-error";
import { CONTACT_EMAILS, type ContactMailboxKey } from "@/lib/ui/contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_CONTEXT = "webhooks/resend-inbound";

/** A Resend webhook event is a few hundred bytes; anything near this is not one. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * Cap on the attached original. Resend's send limit is 40 MB AFTER base64
 * (which inflates by 4/3), so 15 MB of raw message leaves ample headroom.
 */
const MAX_EML_BYTES = 15 * 1024 * 1024;

/** How much of the original text part is quoted in the forward body. */
const MAX_QUOTED_TEXT_CHARS = 20_000;

/** How long the raw-message download may take before it counts as transient. */
const RAW_DOWNLOAD_TIMEOUT_MS = 10_000;

const WHERE_THE_ORIGINAL_IS = "Resend → Emails → Receiving";

type Outcome =
  | "ignored-type"
  | "bad-payload"
  | "too-large"
  | "not-found"
  | "dropped-unlisted"
  | "dropped-loop"
  | "duplicate"
  | "forwarded"
  | "forwarded-without-eml"
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

/**
 * Reads a body without ever holding more than `cap` bytes of it. Null when the
 * declared or the actual length exceeds the cap.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  cap: number,
): Promise<Uint8Array | null> {
  const declared = declaredLength === null ? Number.NaN : Number(declaredLength);
  if (Number.isFinite(declared) && declared > cap) {
    await body?.cancel().catch(() => {});
    return null;
  }
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Reads `type` and `data.email_id` and nothing else from the untrusted body. */
function readEvent(raw: string): { type: unknown; emailId: string | null } | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
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

type EmlResult =
  | { kind: "ok"; base64: string }
  | { kind: "absent" }
  | { kind: "too-large" }
  | { kind: "failed" };

/** Downloads the raw original under MAX_EML_BYTES. `failed` is transient. */
async function downloadEml(email: GetReceivingEmailResponseSuccess): Promise<EmlResult> {
  const url = email.raw?.download_url;
  if (!url) return { kind: "absent" };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(RAW_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { kind: "failed" };
    const bytes = await readCapped(res.body, res.headers.get("content-length"), MAX_EML_BYTES);
    if (bytes === null) return { kind: "too-large" };
    return { kind: "ok", base64: Buffer.from(bytes).toString("base64") };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The forward, as plain text we wrote. `emlNote` is the line explaining why
 * the original is not attached, when it is not.
 */
function composeForward(
  email: GetReceivingEmailResponseSuccess,
  mailbox: ContactMailboxKey,
  to: string,
  emlBase64: string | null,
  emlNote: string | null,
): CreateEmailOptions {
  const address = CONTACT_EMAILS[mailbox];
  const tag = address.split("@")[0];
  const subject = sanitizeHeaderText(email.subject ?? "") || "(sin asunto)";
  const from = sanitizeHeaderText(email.from);
  const original = email.text ?? "";
  const quoted =
    original.length > MAX_QUOTED_TEXT_CHARS
      ? `${original.slice(0, MAX_QUOTED_TEXT_CHARS)}\n\n[… texto recortado; el mensaje completo va en el adjunto .eml]`
      : original;
  const lines = [
    `Correo externo recibido en ${address}. Remitente original: ${from}. Verificá antes de hacer clic.`,
    ...(emlNote ? [emlNote] : []),
    "",
    "----------------------------------------",
    "",
    quoted.trim().length > 0
      ? quoted
      : "(El mensaje original no tiene parte de texto. Abrí el original para verlo.)",
  ];
  return {
    from: FORWARD_SENDER,
    to: [to],
    replyTo: email.reply_to && email.reply_to.length > 0 ? email.reply_to : [email.from],
    subject: `[${tag}] ${subject}`,
    text: lines.join("\n"),
    ...(emlBase64
      ? {
          attachments: [
            {
              filename: "mensaje-original.eml",
              content: emlBase64,
              contentType: "message/rfc822",
            },
          ],
        }
      : {}),
  };
}

/**
 * Svix signature check. True when the request may proceed. With no secret it
 * fails CLOSED in production (see the header) and warns once elsewhere.
 */
function signatureAccepted(req: NextRequest, raw: string, resend: Resend): boolean {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  if (secret.length === 0) {
    if (process.env.VERCEL_ENV === "production") return false;
    if (shouldWarnUnsigned()) {
      console.warn(
        JSON.stringify({
          level: "warn",
          context: LOG_CONTEXT,
          message:
            "RESEND_WEBHOOK_SECRET is not set; signatures are not verified (outside production only)",
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

type SendResult = "sent" | "transient" | "rejected";

async function trySend(
  resend: Resend,
  forward: CreateEmailOptions,
  idempotencyKey: string,
  emailId: string,
  mailbox: ContactMailboxKey,
): Promise<SendResult> {
  const sent = await resend.emails.send(forward, { idempotencyKey });
  if (!sent.error) return "sent";
  if (isTransient(sent.error.statusCode)) return "transient";
  reportError(LOG_CONTEXT, new Error(`forward rejected: ${sent.error.name}`), {
    emailId,
    mailbox,
    statusCode: sent.error.statusCode,
    withEml: "attachments" in forward && forward.attachments !== undefined,
  });
  return "rejected";
}

/**
 * Builds and sends the forward, mapping every result to the webhook's answer.
 *
 * A 4xx on a send that carried the .eml is retried ONCE without it — the
 * attachment is the likeliest cause, and a forward without it still reaches
 * the operator. Every 4xx is reported; none is marked done silently.
 */
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
    const eml = await downloadEml(email);
    if (eml.kind === "failed") {
      releaseHandled(emailId);
      logOutcome("transient", emailId, mailbox);
      return retryLater(502);
    }
    const note =
      eml.kind === "too-large"
        ? `El mensaje original supera el tamaño que se puede adjuntar y no va adjunto: está en ${WHERE_THE_ORIGINAL_IS} (id ${emailId}).`
        : eml.kind === "absent"
          ? `El mensaje original no está disponible como adjunto: está en ${WHERE_THE_ORIGINAL_IS} (id ${emailId}).`
          : null;
    const first = await trySend(
      resend,
      composeForward(email, mailbox, forwardTo, eml.kind === "ok" ? eml.base64 : null, note),
      `inbound-forward/${emailId}`,
      emailId,
      mailbox,
    );
    let result = first;
    if (first === "rejected" && eml.kind === "ok") {
      result = await trySend(
        resend,
        composeForward(
          email,
          mailbox,
          forwardTo,
          null,
          `El proveedor rechazó el mensaje original como adjunto y no va adjunto: está en ${WHERE_THE_ORIGINAL_IS} (id ${emailId}).`,
        ),
        `inbound-forward/${emailId}/sin-adjunto`,
        emailId,
        mailbox,
      );
    }
    if (result === "transient") {
      releaseHandled(emailId);
      logOutcome("transient", emailId, mailbox);
      return retryLater(502);
    }
    markHandled(emailId, "done");
    if (result === "rejected") {
      // Reported inside trySend. A retry would fail identically; the email
      // stays readable in Resend.
      logOutcome("misconfigured", emailId, mailbox);
      return ok();
    }
    logOutcome(
      eml.kind === "ok" && first === "sent" ? "forwarded" : "forwarded-without-eml",
      emailId,
      mailbox,
    );
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

/**
 * The client for the RECEIVING API (`receiving.get`, which also yields the
 * signed raw-download URL). It uses RESEND_INBOUND_API_KEY, a separate
 * full-access key, so that key never touches the send path and the send path
 * keeps RESEND_API_KEY's sending-only scope (least privilege). The first
 * staging test proved the split is required: a sending-only key is refused by
 * the receiving API.
 *
 * Unset in production: reported, and null (the webhook answers 200; a retry
 * does not cure configuration). Outside production it falls back to the
 * sending key so local and preview stay testable with one key.
 */
function resolveInboundClient(sendingKey: string): Resend | null {
  const inboundKey = (process.env.RESEND_INBOUND_API_KEY ?? "").trim();
  if (inboundKey.length > 0) return new Resend(inboundKey);
  if (process.env.VERCEL_ENV === "production") {
    reportError(
      LOG_CONTEXT,
      new Error("RESEND_INBOUND_API_KEY is not set; inbound mail cannot be read or forwarded"),
    );
    return null;
  }
  return new Resend(sendingKey);
}

/** Auth/permission failures of the receiving API: configuration, never "not found". */
const RECEIVING_AUTH_ERRORS = new Set([
  "restricted_api_key",
  "invalid_api_key",
  "missing_api_key",
  "invalid_access",
]);

/**
 * Re-fetches the email by id with the receiving client. Returns the email, or
 * the webhook's answer when there is none. Only a genuine 404 is `not-found`:
 * a 401/403 or permission-type error is REPORTED as a configuration error —
 * logging it as not-found is exactly how the sending-only key hid on staging.
 */
async function fetchInboundEmail(
  inbound: Resend,
  emailId: string,
): Promise<GetReceivingEmailResponseSuccess | NextResponse> {
  const fetched = await inbound.emails.receiving.get(emailId);
  if (!fetched.error && fetched.data) return fetched.data;
  const status = fetched.error?.statusCode;
  const name = fetched.error?.name ?? "";
  if (status === 401 || status === 403 || RECEIVING_AUTH_ERRORS.has(name)) {
    reportError(
      LOG_CONTEXT,
      new Error(
        "Resend receiving API refused the inbound key (401/403); RESEND_INBOUND_API_KEY needs full access",
      ),
      { emailId, statusCode: status ?? null, errorName: name },
    );
    logOutcome("misconfigured", emailId);
    return ok();
  }
  if (status === 404 || name === "not_found") {
    logOutcome("not-found", emailId);
    return ok();
  }
  if (isTransient(status)) {
    logOutcome("transient", emailId);
    return retryLater(503);
  }
  // Any other 4xx: not retryable, not a missing email. Reported, not hidden.
  reportError(LOG_CONTEXT, new Error("Resend receiving API rejected the lookup"), {
    emailId,
    statusCode: status ?? null,
    errorName: name,
  });
  logOutcome("misconfigured", emailId);
  return ok();
}

// @no-auth-required: Resend lo llama desde afuera, sin sesión, y no hay usuario
// al que autorizar. La confianza no sale del pedido: la firma Svix se verifica
// cuando RESEND_WEBHOOK_SECRET está (y en producción, sin secreto, se rechaza
// todo con 401); del cuerpo, acotado en tamaño, se lee solo `type` y
// `data.email_id`, y el correo se vuelve a pedir a Resend con nuestra propia
// clave. Un id inventado da 404 y no pasa nada; un id real solo se reenvía si
// iba dirigido a una casilla publicada, y a un único destino fijo por
// configuración. No devuelve datos: siempre `{ ok }`.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const bytes = await readCapped(
    req.body,
    req.headers.get("content-length"),
    MAX_WEBHOOK_BODY_BYTES,
  );
  if (bytes === null) {
    logOutcome("too-large", null);
    return NextResponse.json({ ok: false }, { status: 413 });
  }
  const raw = Buffer.from(bytes).toString("utf8");

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

  const inbound = resolveInboundClient(apiKey);
  if (inbound === null) {
    logOutcome("misconfigured", null);
    return ok();
  }

  const event = readEvent(raw);
  if (event === null || (event.type === "email.received" && event.emailId === null)) {
    logOutcome("bad-payload", null);
    return ok();
  }
  if (event.type !== "email.received" || event.emailId === null) {
    logOutcome("ignored-type", null);
    return ok();
  }
  const emailId = event.emailId;
  if (alreadyHandled(emailId)) {
    logOutcome("duplicate", emailId);
    return ok();
  }

  const fetched = await fetchInboundEmail(inbound, emailId);
  if (fetched instanceof NextResponse) return fetched;
  const email = fetched;

  // Our own forward arriving back (a misrouted MAIL_FORWARD_TO, an auto-reply
  // chain): never forward it again.
  if (isForwardSender(email.from)) {
    logOutcome("dropped-loop", emailId);
    return ok();
  }

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
