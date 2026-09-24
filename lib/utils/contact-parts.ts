// Turns a free-text contact value into the individual contacts it carries, and
// each of those into something tappable.
//
// "A PHONE OR AN EMAIL" IS WHAT THE FORM ASKS FOR, NOT WHAT IS STORED. The
// finder form takes a phone and an email in two fields and
// `app/(public)/p/[publicToken]/encontre/action.ts` joins them with
// `CONTACT_SEPARATOR` into the single `finderContact` text column the event
// payload carries. Read back as ONE value, that string contains both a phone and
// an "@", and a consumer that builds `tel:${value}` produces
// `tel:11 4123-4567 / ana@example.com` — a URL no dialer accepts, with the email
// swallowed inside it. The producer cannot change without migrating every stored
// value, so the split belongs on the CONSUMER side, keyed on the exact literal
// the producer writes.
//
// THIS IS THE WEB HALF OF A PAIR. `apps/mobile/src/ui/contact-link.ts` is the
// same decision for the native client, and the two must agree part-for-part:
// same separator literal, same trim, same drop of empties and duplicates, same
// order, same "@ means email / enough digits means phone" test, same refusal to
// link anything else. They are separate files because one returns hrefs for the
// DOM and the other feeds `Linking.openURL`, and neither tree imports the other.
// When one changes, the other is the second half of the change.
//
// PURE ON PURPOSE: deciding WHICH kind a value is, and what href and label it
// becomes, is testable without rendering anything.

/** A contact value resolved into something a screen reader can act on.
 * `null` means the value could not become a link — too short to be a real
 * phone number and no "@" to read as an email — so the caller falls back to
 * plain, unlinked text. */
export type ContactLink = {
  href: string;
  label: string;
  kind: "phone" | "email";
};

/**
 * The separator the finder action writes when a finder leaves BOTH contacts.
 *
 * Kept as a named constant on both sides of the wire so the producer's literal
 * and the consumer's split are one decision rather than two strings that agree
 * today.
 */
export const CONTACT_SEPARATOR = " / ";

/**
 * One free-text contact value split into the individual contacts it carries.
 *
 * Trimmed, empties dropped, DUPLICATES DROPPED — the same number written twice
 * is one contact, and two identical links would be two identical targets doing
 * the same thing. A value with no separator yields one part, which is why every
 * single-contact caller behaves exactly as it did before this existed.
 */
export function contactParts(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(CONTACT_SEPARATOR)) {
    const trimmed = part.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/** One contact, as a link — or `null` when it cannot become one. */
export function contactLink(value: string): ContactLink | null {
  const trimmed = value.trim();

  if (trimmed.includes("@")) {
    return { href: `mailto:${trimmed}`, label: `Escribir a ${trimmed}`, kind: "email" };
  }

  // Strip everything but digits and "+" — a `tel:` URL built from unsanitized
  // spaces and dashes ("tel:11 4123-4567") is rejected by some dialers. A "+" is
  // kept only when it led the original value, and only at index 0: "54+9+11" has
  // no business becoming "+5491+1".
  const stripped = trimmed.replace(/[^\d+]/g, "");
  const hasLeadingPlus = stripped.startsWith("+");
  const digits = stripped.replace(/\+/g, "");
  if (digits.length < 6) return null; // too short to be a dialable number

  const sanitized = hasLeadingPlus ? `+${digits}` : digits;
  return { href: `tel:${sanitized}`, label: `Llamar al ${trimmed}`, kind: "phone" };
}

/**
 * Every part of `value`, paired with the link it can become (or `null`).
 *
 * PER PART, NOT PER LINK, and that is the shape callers want: a half that cannot
 * become a link is still shown as text rather than disappearing off a surface
 * whose whole purpose is reaching the person on the other end.
 */
export function contactPartLinks(value: string): Array<{ part: string; link: ContactLink | null }> {
  return contactParts(value).map((part) => ({ part, link: contactLink(part) }));
}
