// DNI redaction for free-text that is about to be persisted or displayed.
//
// Invariant 5 (no DNI in plaintext) admits no exception for an append-only
// table: an `audit_log` row can never be deleted, so a DNI typed into an
// operator search box and stored as `payload.query` would live forever. This
// module is the pure half (no crypto, no env) so it can run anywhere —
// the audit writer AND the history screens that still render rows written
// before the writer redacted.
//
// What counts as DNI-shaped: a run of exactly 7-8 digits (`12345678`) or the
// dotted/spaced thousands form (`12.345.678`, `1.234.567`, `12 345 678`),
// not glued to a longer digit run. That is the same space
// `lib/infra/admin-search.ts` treats as a DNI. Longer digit runs (phones,
// ids) are deliberately left alone.

/** One DNI-shaped token. Dotted form first so `12.345.678` is not split. */
const DNI_TOKEN_SOURCE = String.raw`(?<!\d)(?:\d{1,2}[.\s]\d{3}[.\s]\d{3}|\d{7,8})(?!\d)`;

const MIDDLE_DOT = "·";

/** The non-reversible stand-in written in place of a DNI: `[DNI ···5678]`. */
export function dniMarker(digits: string): string {
  return `[DNI ${MIDDLE_DOT.repeat(3)}${digits.slice(-4)}]`;
}

export interface DniRedaction {
  /** `text` with every DNI-shaped token replaced by its marker. */
  text: string;
  /** The digits of each DNI found, in order (separators stripped). Handle with care. */
  dnis: string[];
}

/**
 * Replace every DNI-shaped token in `text` with a marker. Text with no DNI
 * comes back unchanged (same string, empty `dnis`).
 */
export function redactDni(text: string): DniRedaction {
  const dnis: string[] = [];
  const redacted = text.replace(new RegExp(DNI_TOKEN_SOURCE, "g"), (match) => {
    const digits = match.replace(/\D/g, "");
    dnis.push(digits);
    return dniMarker(digits);
  });
  return { text: redacted, dnis };
}

/** Display-side convenience: the redacted text only. */
export function redactDniText(text: string): string {
  return redactDni(text).text;
}
