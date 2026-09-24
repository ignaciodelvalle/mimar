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

// ---------- The native picker's side of the same strings ---------------------
//
// The picker (`DateField`/`TimeField` in kit.tsx, M18) speaks `Date`; the
// caller's state speaks the SAME masked strings the typed field produces. These
// four functions are the whole crossing, and they read and write LOCAL calendar
// components on purpose: the dialog shows the device's calendar, so the day the
// person tapped is the day `getDate()` answers — never a UTC day that can be
// one off after 21:00 in Argentina.
//
// NOON, NOT MIDNIGHT. A `Date` built for a calendar day sits at 12:00 local, so
// no timezone or DST shift can push it across a day boundary before it reaches
// the dialog.

const AR_DAY_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PARTS_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * `YYYY-MM-DD` → a local `Date` at noon on that day, or `null` when the string
 * is not a real calendar day (`2026-02-31` is `null`, not 3 March).
 */
export function isoDayToLocalDate(iso: string): Date | null {
  const match = AR_DAY_PARTS_RE.exec(iso.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** What the date field holds (`DD/MM/AAAA` or ISO) → a local noon `Date`, or `null`. */
export function dateInputToLocalDate(text: string): Date | null {
  return isoDayToLocalDate(dateInputToIso(text));
}

/** A picked `Date` → `DD/MM/AAAA`, exactly what the mask draws for the same day. */
export function localDateToDateInput(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return maskDateInput(`${day}${month}${String(date.getFullYear()).padStart(4, "0")}`);
}

/**
 * What the time field holds (`HH:MM`) → a local `Date` on `base`'s day at that
 * time, or `null` when it is not a wall-clock time.
 */
export function timeInputToLocalDate(text: string, base: Date): Date | null {
  const match = TIME_PARTS_RE.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const date = new Date(base.getTime());
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** A picked `Date` → `HH:MM` on a 24-hour clock, what the mask draws. */
export function localDateToTimeInput(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return maskTimeInput(`${hours}${minutes}`);
}
