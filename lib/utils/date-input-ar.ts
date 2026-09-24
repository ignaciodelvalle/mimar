// ---------------------------------------------------------------------------
// Browser-independent dd/mm/aaaa date + HH:mm time entry
// ---------------------------------------------------------------------------
//
// Native `<input type="date">` renders its VISIBLE text per the browser's OS
// locale, not per any attribute we control. `lang="es-AR"` only nudges
// Chromium; Safari/Firefox ignore it and show mm/dd/yyyy on an en-US machine.
// An es-AR operator then reads "03/07" as 7-March while the browser meant
// 3-July → the submitted range is silently wrong. These helpers back a
// hand-rolled dd/mm/aaaa text input (DateInputAr) that displays identically on
// EVERY browser and still emits an ISO `yyyy-mm-dd` value for the query.
//
// All three are pure (no DOM) and unit-tested. Split out of lib/utils/format.ts
// when that module hit the 1500-line fence (2026-08-06) — this block was its
// only fully self-contained island.

const AR_DATE_DISPLAY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ISO `yyyy-mm-dd` → es-AR display `dd/mm/aaaa`. Returns "" for empty or
 * non-ISO input (so a blank/garbage default renders as an empty field, never
 * a broken string).
 */
export function isoToArDateDisplay(value: string | null | undefined): string {
  if (!value) return "";
  const m = value.match(ISO_DATE_RE);
  if (!m) return "";
  const [, yyyy, mm, dd] = m;
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * es-AR display `dd/mm/aaaa` → ISO `yyyy-mm-dd`, or `null` when the string is
 * empty, malformed, or an impossible calendar date (32/13/2026, 31/02/2026,
 * 29/02/2025). Validates the day against the real length of the given month so
 * a wrong range can be CLEARED instead of submitted.
 */
export function parseArDateToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(AR_DATE_DISPLAY_RE);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  if (month < 1 || month > 12) return null;
  if (year < 1) return null;
  // day 0 of the NEXT month (1-based `month` as the 0-based index of the month
  // after) is the last day of the target month — the real length, leap-aware.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Progressive input mask for dd/mm/aaaa: keeps only digits (max 8) and inserts
 * the slashes as the operator types, so the field always reads dd, dd/mm, or
 * dd/mm/aaaa. Pure string transform — no validation (that is `parseArDateToIso`).
 */
export function maskArDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Time half — HH:mm, 24-hour, browser-independent (TimeInputAr)
// ---------------------------------------------------------------------------
//
// `<input type="time">` has EXACTLY the same defect as `<input type="date">`:
// its visible text follows the browser's locale, so a viewer on an en-US
// machine gets a 12-hour "07:30 PM" widget while the es-AR copy around it
// (and every rendered timestamp in the product) speaks 24-hour "19:30". On the
// citizen crisis surfaces that ambiguity is a wrong sighting hour, not a
// cosmetic wobble. These helpers back TimeInputAr, the HH:mm twin of
// DateInputAr: masked text in, a validated "HH:mm" string out.
//
// Note the asymmetry with the date half: a time needs no display<->storage
// conversion, because "HH:mm" IS both the es-AR display form and the value the
// consumer submits. So there is no `hmToArTimeDisplay` — `parseArTimeToHm` is
// both the validator and the normalizer.

const AR_TIME_DISPLAY_RE = /^(\d{2}):(\d{2})$/;

/**
 * Validate/normalize an "HH:mm" 24-hour time, or `null` when the string is
 * empty, malformed, or out of range (24:00, 12:60, "7:5"). Hours are 00-23 and
 * minutes 00-59 — a 12-hour "07:30 PM" never round-trips through here, which is
 * the point: the value is unambiguous on every browser and locale.
 */
export function parseArTimeToHm(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(AR_TIME_DISPLAY_RE);
  if (!m) return null;
  const [, hh, mm] = m;
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23) return null;
  if (minute > 59) return null;
  return `${hh}:${mm}`;
}

/**
 * Progressive input mask for HH:mm: keeps only digits (max 4) and inserts the
 * colon as the citizen types, so the field always reads HH or HH:mm. Pure
 * string transform — no range validation (that is `parseArTimeToHm`).
 */
export function maskArTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

// "YYYY-MM-DD" from <input type="date">, exactly — nothing looser.
const AR_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The FIRST instant of an Argentine calendar day, from a `<input type="date">`
 * "YYYY-MM-DD" string. Null for empty/malformed input.
 *
 * "MALFORMED" MEANS THE SHAPE AND THE MONTH, NOT THE DAY — measured, 2026-08-26,
 * and stated because the sentence above reads like a stronger promise than it is.
 * `2026-13-01` is `Invalid Date` and answers null; `2026-02-31` is NOT — the
 * ECMAScript date parser ROLLS IT OVER, so this returns the 3rd of March. Both
 * callers are safe today for the same reason the defect went unnoticed: an
 * `<input type="date">` cannot emit an impossible day. A JSON CLIENT CAN, so a
 * door that takes a bare date string has to check the calendar BEFORE calling
 * these. `@dim/contract/input`'s `ar-calendar-day.ts` owns that check for the
 * whole `/api/v1` surface (`isRealArDay`), which is where the caretaker and
 * asiento schemas both get it; `parseArDateToIso` above owns the equivalent for
 * the dd/mm/aaaa spelling the web's own inputs use. Do not write a third.
 *
 * WHY THIS EXISTS ALONGSIDE `parseDateInput`. `parseDateInput` anchors at NOON
 * UTC, which is enough to make the day render correctly in any AR-pinned
 * formatter — and that is all it was ever asked to do. It is the wrong answer
 * when the instant is a BOUNDARY a job acts on: noon UTC is 09:00 ART, so a
 * period "hasta el 15/09" would stop being honoured at nine in the morning on
 * the 15th. Use `parseDateInput` for a date you only display; use these two for
 * a date that opens or closes a window.
 *
 * Argentina is UTC-3 year-round (no DST since 2009), so the fixed offset is
 * exact and needs no zone database — the same reasoning as
 * `parseArDatetimeLocal`.
 */
export function parseArDateStartOfDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!AR_DATE_ONLY_RE.test(trimmed)) return null;
  const d = new Date(`${trimmed}T00:00:00.000-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The LAST instant of an Argentine calendar day (23:59:59.999 ART).
 *
 * "El cuidado va hasta el 15/09" means the caretaker keeps access for all of
 * the 15th. Anything earlier revokes access on a day the titular promised.
 */
export function parseArDateEndOfDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!AR_DATE_ONLY_RE.test(trimmed)) return null;
  const d = new Date(`${trimmed}T23:59:59.999-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
