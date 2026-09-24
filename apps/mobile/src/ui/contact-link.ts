// Turns a free-text contact value into tappable links, or refuses to when the
// value cannot become one.
//
// "A PHONE OR AN EMAIL" IS WHAT THE SCHEMA SAYS, NOT WHAT ARRIVES. The lost
// owner's `phoneE164` really is one phone, but `finderContact`
// (@dim/contract/api/pet-lost) is a single text column that the web's finder
// form fills with BOTH contacts, joined by `CONTACT_SEPARATOR`, when the finder
// leaves both. So a stored value is read by SPLITTING it first: `contactParts`
// for the parts and `contactLink` for the single-contact decision on each one.
// That PAIR is the entry point on this side — `ContactRow` in components.tsx
// calls exactly those two — and the web reaches the same place through one call,
// `contactPartLinks` (lib/utils/contact-parts.ts), which is the same two steps
// composed. `contactLinks` below composes them too and, since components.tsx
// stopped importing it, has no caller but its own test; it stays because
// removing exported code is a separate decision, not because anything renders
// through it.
//
// PURE ON PURPOSE: `ContactRow` in components.tsx is a rendering shell
// around this. Deciding WHICH kind a value is, and what href/label it
// becomes, belongs here so it can be pinned without mounting React Native.

/** A contact value resolved into something a screen reader can act on.
 * `null` means the value could not become a link — too short to be a real
 * phone number and no "@" to read as an email — so the caller falls back
 * to a plain, unlinked row. */
export type ContactLink = {
  href: string;
  label: string;
  kind: "phone" | "email";
};

export function contactLink(value: string): ContactLink | null {
  const trimmed = value.trim();

  if (trimmed.includes("@")) {
    return { href: `mailto:${trimmed}`, label: `Escribir a ${trimmed}`, kind: "email" };
  }

  // Strip everything but digits and "+" — a `tel:` URL built from
  // unsanitized spaces/dashes ("tel:11 4123-4567") is rejected by some
  // dialers. A "+" is kept only when it led the original value, and only at
  // index 0 — "54+9+11" has no business becoming "+5491+1".
  const stripped = trimmed.replace(/[^\d+]/g, "");
  const hasLeadingPlus = stripped.startsWith("+");
  const digits = stripped.replace(/\+/g, "");
  if (digits.length < 6) return null; // too short to be a dialable number

  const sanitized = hasLeadingPlus ? `+${digits}` : digits;
  return { href: `tel:${sanitized}`, label: `Llamar al ${trimmed}`, kind: "phone" };
}

/**
 * The separator the WEB writes when a finder leaves both a phone and an email.
 *
 * THE PRODUCER IS THE AUTHORITY, so it is named and not quoted: the finder
 * action `app/(public)/p/[publicToken]/encontre/action.ts` builds the single
 * `finderContact` text column by joining the two form fields with its own
 * `CONTACT_SEPARATOR`. This comment used to pin a line number and restate the
 * template literal; the line number was already stale one commit later, which is
 * the whole argument for naming the symbol instead.
 *
 * The schema carries one field, so two contacts arrive concatenated. Read as ONE
 * value that string contains an "@", and `contactLink` turns the whole thing
 * into a single `mailto:` with the phone number swallowed inside it — an address
 * no mail client can send to. The producer cannot be changed from here without
 * migrating every stored value, so the split belongs on the CONSUMER side, keyed
 * on the exact literal the producer writes. `lib/utils/contact-parts.ts` holds
 * the web's copy of it, and the two must stay byte-identical.
 */
export const CONTACT_SEPARATOR = " / ";

/**
 * One free-text contact value split into the individual contacts it carries.
 *
 * Trimmed, empties dropped, DUPLICATES DROPPED — the same number written twice
 * is one contact, and two identical rows would be two identical touch targets
 * doing the same thing. A value with no separator yields one part, which is why
 * every single-contact caller behaves exactly as it did before this existed.
 */
export function contactParts(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(CONTACT_SEPARATOR)) {
    const trimmed = part.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Every contact in `value` that can become a link, in the order written.
 *
 * Parts that cannot become one are DROPPED, so an empty array means "nothing
 * here is tappable" and the caller falls back to plain text — the same contract
 * `contactLink`'s `null` has for a single value. `ContactRow` renders per PART
 * rather than per link, so a half that drops out here is still shown as text.
 */
export function contactLinks(value: string): ContactLink[] {
  const links: ContactLink[] = [];
  for (const part of contactParts(value)) {
    const link = contactLink(part);
    if (link !== null) links.push(link);
  }
  return links;
}
