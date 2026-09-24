/**
 * Single source of truth for the mailboxes miMAR publishes to its users.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The same two addresses were retyped across five files — /privacidad,
 * /terminos, /gob/analytics, /gob/perdidas and the locality picker's
 * zero-result state — and one of those files had already noticed the smell and
 * made a local `const CATALOG_CONTACT_EMAIL`. A local const is a single source
 * of truth for one file and a decoy for the other four.
 *
 * That cost was collected on 2026-09-07. Every one of those nine lines named
 * `@mimar.ar`, a domain that DOES NOT EXIST: two independent resolvers
 * (8.8.8.8, 1.1.1.1) answered `Non-existent domain` — no NS, no MX. So every
 * address the product published bounced. The worst of them was
 * `privacidad@mimar.ar`, offered on /privacidad as THE channel to exercise Ley
 * 25.326 rights of access and erasure: a person locked out of the app had no
 * other door, and the door was painted on.
 *
 * The domain that exists is `mimar.com.ar` — the origin the site itself is
 * served from (https://www.mimar.com.ar), with MX pointing at Resend
 * (inbound-smtp.sa-east-1.amazonaws.com) and verified there since 2026-08-28.
 *
 * WHAT KEEPS IT FROM HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * `__tests__/contact-email-domain-fence.test.tsx` bans the SUBJECT, not the
 * dead spelling: no shipped file under app/ or components/ may name an email
 * address at a domain absent from OWNED_MAIL_DOMAINS below. Banning
 * "mimar.ar" would have caught yesterday's typo and nothing else; banning
 * "an address we cannot receive mail at" catches the next one too.
 */

/**
 * Domains this project actually controls and can receive mail at.
 *
 * ADD A DOMAIN HERE ONLY AFTER IT RESOLVES AND HAS MX. This list is the
 * fence's definition of "reachable", so an aspirational entry does not widen
 * the allowlist — it disarms the check. `mimar.gob.ar`, the eventual
 * government origin, is deliberately absent until it is delegated.
 */
export const OWNED_MAIL_DOMAINS = ["mimar.com.ar"] as const;

/** The domain every published address is built from. */
export const PRIMARY_MAIL_DOMAIN = OWNED_MAIL_DOMAINS[0];

/**
 * Every mailbox the product invites a user to write to.
 *
 * Composed from PRIMARY_MAIL_DOMAIN rather than typed out, so the domain is
 * spelled exactly once in the repository and a future migration is one line
 * instead of the nine-site sweep this module was born from.
 */
export const CONTACT_EMAILS = {
  /** General enquiries, catalog gaps, access requests, verification doubts. */
  general: `hola@${PRIMARY_MAIL_DOMAIN}`,
  /** Ley 25.326 rights of the data subject — access, rectification, erasure. */
  privacy: `privacidad@${PRIMARY_MAIL_DOMAIN}`,
} as const;

/**
 * Builds a `mailto:` href with a correctly percent-encoded subject and body.
 *
 * The four call sites used to hand-write their encoding (`miMAR%20%E2%80%94%20`
 * for "miMAR — "), which is unreadable at the point of use and silently wrong
 * the first time somebody adds an accent or an ampersand by hand.
 */
export function mailtoHref(address: string, parts?: { subject?: string; body?: string }): string {
  const query = [
    parts?.subject === undefined ? null : `subject=${encodeURIComponent(parts.subject)}`,
    parts?.body === undefined ? null : `body=${encodeURIComponent(parts.body)}`,
  ]
    .filter((part): part is string => part !== null)
    .join("&");
  return query.length > 0 ? `mailto:${address}?${query}` : `mailto:${address}`;
}

/**
 * The one channel an operator (gob / org / admin) uses to reach a person —
 * the rail's "¿Necesitás ayuda?", the crons-down banner and /sugerencias all
 * name THIS address (pilot T1-P5), so "avisá a soporte" always points at a
 * mailbox somebody reads. It is the general mailbox on purpose: there is no
 * separate support desk yet, and inventing an address nobody reads would be
 * the painted door this module's header describes.
 */
export const OPERATOR_HELP_EMAIL = CONTACT_EMAILS.general;

/** `mailto:` for OPERATOR_HELP_EMAIL with a subject that sorts it in the inbox. */
export function operatorHelpHref(): string {
  return mailtoHref(OPERATOR_HELP_EMAIL, { subject: "miMAR — pedido de ayuda" });
}
