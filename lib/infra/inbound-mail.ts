// inbound-mail — the pure half of the Resend inbound webhook
// (app/api/webhooks/resend-inbound/route.ts): which published mailbox an email
// was addressed to, and a per-instance guard against forwarding it twice.
//
// It lives here and not in the route because a Next.js route.ts may export
// only handlers and route config; anything else breaks the build.

import { CONTACT_EMAILS, type ContactMailboxKey, PRIMARY_MAIL_DOMAIN } from "@/lib/ui/contact";

/**
 * The From: of every forward. A fixed address on the owned (Resend-verified)
 * domain rather than RESEND_FROM: that variable may still be the provider's
 * shared test sender, which can only reach the account owner, and a forward
 * must never depend on that.
 */
export const FORWARD_SENDER = `miMAR reenvío <reenvio@${PRIMARY_MAIL_DOMAIN}>`;

/**
 * Precedence when one email is addressed to several published mailboxes: the
 * rights channel first, because its subject tag is the one the operator must
 * not miss.
 */
const MAILBOX_PRECEDENCE: readonly ContactMailboxKey[] = ["privacy", "pilots", "general"];

/**
 * Normalises one recipient as Resend reports it (`"Name" <a@b>` or `a@b`):
 * lowercase, `+tag` stripped from the local part. Null for anything that is
 * not an address.
 */
export function normalizeMailbox(raw: string): string | null {
  const angle = raw.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : raw).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const local = address.slice(0, at).split("+")[0];
  if (local.length === 0) return null;
  return `${local}@${address.slice(at + 1)}`;
}

/**
 * Which published mailbox, if any, this email was addressed to. Derived from
 * CONTACT_EMAILS, so a mailbox added there is forwarded without touching the
 * route, and an address absent from it (spam to invented local parts) is not.
 */
export function matchPublishedMailbox(
  recipients: readonly (string | null | undefined)[],
): ContactMailboxKey | null {
  const normalized = new Set(
    recipients.map((r) => (r ? normalizeMailbox(r) : null)).filter((r): r is string => r !== null),
  );
  for (const key of MAILBOX_PRECEDENCE) {
    if (normalized.has(CONTACT_EMAILS[key].toLowerCase())) return key;
  }
  return null;
}

/**
 * True when an address is on the inbound domain or any subdomain of it
 * (forwarding there loops back through the webhook).
 */
export function isOnInboundDomain(normalizedAddress: string): boolean {
  const domain = normalizedAddress.slice(normalizedAddress.lastIndexOf("@") + 1);
  return domain === PRIMARY_MAIL_DOMAIN || domain.endsWith(`.${PRIMARY_MAIL_DOMAIN}`);
}

/** True when a From: is our own forward sender — the mail is one of our forwards coming back. */
export function isForwardSender(from: string): boolean {
  const sender = normalizeMailbox(from);
  return sender !== null && sender === normalizeMailbox(FORWARD_SENDER);
}

/** Longest subject/sender fragment we copy into a header or the banner. */
const MAX_HEADER_TEXT_CHARS = 300;

/**
 * Makes attacker-controlled header text safe to reuse: every control
 * character (CR/LF included, so no header injection or fake second line)
 * becomes a space, runs collapse, and the result is bounded.
 */
export function sanitizeHeaderText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s{2,}/g, " ");
  return cleaned.trim().slice(0, MAX_HEADER_TEXT_CHARS);
}

// --- per-instance duplicate guard ------------------------------------------
//
// Resend retries a webhook until it sees a 2xx, and may deliver twice anyway.
// This is a small insertion-ordered LRU of the email ids this instance has
// forwarded, or is forwarding right now. Per instance by design: no table, no
// migration. A retry that lands on another instance is caught by the
// Idempotency-Key on the send (Resend dedupes it for 24 h), so a duplicate
// needs BOTH to miss. Rare, and accepted.
const SEEN_LIMIT = 500;
const seen = new Map<string, "inflight" | "done">();

export function alreadyHandled(emailId: string): boolean {
  return seen.has(emailId);
}

export function markHandled(emailId: string, state: "inflight" | "done"): void {
  seen.delete(emailId);
  seen.set(emailId, state);
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** Releases an id after a transient failure, so Resend's retry can forward it. */
export function releaseHandled(emailId: string): void {
  seen.delete(emailId);
}

let warnedUnsigned = false;

/** True exactly once per instance: the "no webhook secret" warning is not a flood. */
export function shouldWarnUnsigned(): boolean {
  if (warnedUnsigned) return false;
  warnedUnsigned = true;
  return true;
}

/** Test seam: forget every remembered id and re-arm the one-time warning. */
export function __resetInboundMailStateForTests(): void {
  seen.clear();
  warnedUnsigned = false;
}
