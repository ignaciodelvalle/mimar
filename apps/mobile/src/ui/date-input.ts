// Dates as a person in Argentina types them, and the mask that makes a number
// pad enough to type them.
//
// THE DEFECT THIS CLOSES (mobile QoL audit 2026-09-05, forms-F1 + forms-F2).
// Every date field in the app asked for `AAAA-MM-DD` — the wire format, which
// is what `<input type="date">` posts on the web and what the contract's regex
// accepts — over a keyboard that on Android had no number pad at all
// (`keyboardType="numbers-and-punctuation"` is iOS-only; Android fell back to
// QWERTY). A person who typed the date the way every Argentine form asks for
// it, `20/08/2026`, was told "la fecha no existe": a sentence about a calendar,
// aimed at a format.
//
// TWO DECISIONS, and they depend on each other:
//
//   · THE FIELD SHOWS `DD/MM/AAAA` AND THE WIRE STAYS `YYYY-MM-DD`. The server
//     does not change; `dateInputToIso` converts at the view-model boundary,
//     right before the contract's schema runs. ISO passes through untouched so
//     nothing that already speaks the wire format (tests, a pasted value) breaks.
//
//   · THE FIELD IS MASKED, so `inputMode="numeric"` is sufficient. An Android
//     number pad has no `/` on most keyboards, which is why the audit's own
//     remedy ("numeric only if the format is digits + slashes") could not be
//     applied as written. With the mask, a person types eight digits and the
//     slashes appear; the pad never has to produce one.
//
// THE MASK NEVER ADDS A TRAILING SEPARATOR. `2008` → `20/08`, but `20` → `20`,
// not `20/`. A separator inserted the moment a group completes looks helpful and
// makes backspace impossible: deleting the `/` hands the mask `20`, the mask
// re-inserts the `/`, and the field is stuck. Separators appear only BETWEEN two
// groups that both have digits, so every keystroke, forward or back, is
// reversible.
//
// PURE, so it is testable without a renderer, and shared by the kit (the mask)
// and the view-models (the conversion) so the two cannot disagree about what a
// slash means.

/** Digit-group lengths for a calendar day typed as `DD/MM/AAAA`. */
export const DATE_GROUPS: readonly number[] = [2, 2, 4];
/** Digit-group lengths for a wall-clock time typed as `HH:MM`. */
export const TIME_GROUPS: readonly number[] = [2, 2];

/**
 * Keep the digits, drop everything else, and lay them out in `groups` joined by
 * `separator`. Digits past the last group are discarded.
 */
export function maskDigits(text: string, groups: readonly number[], separator: string): string {
  const capacity = groups.reduce((sum, size) => sum + size, 0);
  const digits = text.replace(/\D/g, "").slice(0, capacity);
  const parts: string[] = [];
  let offset = 0;
  for (const size of groups) {
    if (offset >= digits.length) break;
    parts.push(digits.slice(offset, offset + size));
    offset += size;
  }
  return parts.join(separator);
}

/** `DD/MM/AAAA` mask. */
export function maskDateInput(text: string): string {
  return maskDigits(text, DATE_GROUPS, "/");
}

/** `HH:MM` mask. */
export function maskTimeInput(text: string): string {
  return maskDigits(text, TIME_GROUPS, ":");
}

const AR_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a person typed → what the contract accepts.
 *
 * `20/08/2026` and `2/8/2026` become `2026-08-20`; `2026-08-20` passes through.
 * ANYTHING ELSE COMES BACK TRIMMED AND UNCHANGED, on purpose: this function
 * does not judge. A half-typed `20/0` reaches the schema as `20/0`, the schema
 * answers `*_MALFORMED`, and the person reads "escribí la fecha como
 * DD/MM/AAAA" — the honest sentence, from the one vocabulary. Whether
 * `31/02/2026` is a real day is likewise the contract's call (`isRealArDay`),
 * not this function's; it converts the shape and nothing more.
 */
export function dateInputToIso(text: string): string {
  const trimmed = text.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;
  const match = AR_DATE_RE.exec(trimmed);
  if (match === null) return trimmed;
  const [, day, month, year] = match;
  return `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
}

/**
 * The wire format → what the field shows. For pre-filling "today".
 *
 * A string that is not `YYYY-MM-DD` comes back unchanged rather than mangled:
 * the mask would otherwise read `2026-09-06` as eight digits and draw
 * `20/26/0906`.
 */
export function isoToDateInput(iso: string): string {
  const trimmed = iso.trim();
  if (!ISO_DATE_RE.test(trimmed)) return trimmed;
  const [year, month, day] = trimmed.split("-");
  return `${day}/${month}/${year}`;
}
