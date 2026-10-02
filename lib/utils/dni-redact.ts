// DNI redaction for free-text that is about to be persisted or displayed.
//
// Invariant 5 (no DNI in plaintext) admits no exception for an append-only
// table: an `audit_log` row can never be deleted, so a DNI typed into an
// operator search box and stored as `payload.query` would live forever. This
// module is the pure half (no crypto, no env) so it can run anywhere —
// the audit writer AND the history screens that still render rows written
// before the writer redacted.
//
// What counts as DNI-shaped, never glued to a longer digit run:
//   - a run of exactly 7-8 digits (`12345678`);
//   - the thousands form with `.`, `,`, `-` or a space as separator, in
//     both places (`12.345.678`, `1.234.567`, `12 345 678`, `12-345-678`,
//     `12,345,678`) or in only one (`12.345678`, `12345.678`) — an operator
//     types what they type, and redaction must be at least as wide as the
//     search (`lib/infra/admin-search.ts`), never narrower;
//   - a CUIT/CUIL (11 digits: a 20/23/24/27/30/33/34 prefix, the 8-digit DNI,
//     a check digit; bare or with `-`, `.` or space separators). It embeds
//     the DNI whole, so it is masked whole: `[CUIT ···6789]`.
// Other digit runs (6 or fewer, 9-10, an 11-digit run with no CUIT prefix,
// 12+: phones, ids, tokens) are deliberately left alone.

const SEP = String.raw`[.\s,-]`;

/**
 * One CUIT/CUIL-shaped token, captured as prefix / DNI / check digit. Tried
 * BEFORE the DNI form so the DNI inside it is not masked on its own.
 */
const CUIT_SOURCE = String.raw`(?<!\d)(?<cuitPrefix>20|23|24|27|30|33|34)[-.\s]?(?<cuitDni>\d{8}|\d{2}\.\d{3}\.\d{3})[-.\s]?(?<cuitCheck>\d)(?!\d)`;

/**
 * One DNI-shaped token. Separated forms first so `12.345.678` is not split;
 * at most one separator between digit groups, so a dashed phone
 * (`11-4567-8901`) never matches.
 */
const DNI_SOURCE = String.raw`(?<!\d)(?<dni>\d{1,2}${SEP}\d{3}${SEP}\d{3}|\d{1,2}${SEP}\d{6}|\d{4,5}${SEP}\d{3}|\d{7,8})(?!\d)`;

const TOKEN_SOURCE = `${CUIT_SOURCE}|${DNI_SOURCE}`;

const MIDDLE_DOT = "·";

/** The non-reversible stand-in written in place of a DNI: `[DNI ···5678]`. */
export function dniMarker(digits: string): string {
  return `[DNI ${MIDDLE_DOT.repeat(3)}${digits.slice(-4)}]`;
}

/** The stand-in for a CUIT/CUIL (its last four digits): `[CUIT ···6789]`. */
export function cuitMarker(digits: string): string {
  return `[CUIT ${MIDDLE_DOT.repeat(3)}${digits.slice(-4)}]`;
}

export interface DniRedaction {
  /** `text` with every DNI-shaped token replaced by its marker. */
  text: string;
  /**
   * The digits of each DNI found, in order (separators stripped) — for a
   * CUIT/CUIL, the DNI it embeds, so a sweep over one person stays countable
   * whichever document was typed. Handle with care.
   */
  dnis: string[];
}

/**
 * Replace every DNI-shaped token in `text` with a marker. Text with no DNI
 * comes back unchanged (same string, empty `dnis`).
 */
export function redactDni(text: string): DniRedaction {
  const dnis: string[] = [];
  const redacted = text.replace(new RegExp(TOKEN_SOURCE, "g"), (...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.cuitDni !== undefined) {
      const dni = groups.cuitDni.replace(/\D/g, "");
      dnis.push(dni);
      return cuitMarker(`${groups.cuitPrefix}${dni}${groups.cuitCheck}`);
    }
    const digits = (groups.dni ?? "").replace(/\D/g, "");
    dnis.push(digits);
    return dniMarker(digits);
  });
  return { text: redacted, dnis };
}

/** Display-side convenience: the redacted text only. */
export function redactDniText(text: string): string {
  return redactDni(text).text;
}
