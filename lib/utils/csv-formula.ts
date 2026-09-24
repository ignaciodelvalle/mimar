// csv-formula.ts — the one place that defuses CSV formula injection.
//
// WHY THIS FILE EXISTS AT ALL, given that this repository deliberately keeps
// four separate CSV escapers and each one says in its own comment why it is not
// shared. Those reasons are about RFC 4180 QUOTING, and they are good: the open
// data serializer always quotes its suppression marker, the operator-queue
// builder must stay diffable between two exports of the same screen, and the
// panorama table is reference territory. Quoting rules differ per surface on
// purpose.
//
// Formula neutralisation is not a quoting rule. It is the same decision at every
// surface, for the same reason, and getting it wrong has the same consequence
// wherever it happens. Duplicating it four times is how five of six builders
// ended up without it — which is exactly what
// `dim-interno:docs/reviews/2026-08-04-print-surfaces-audit.md` finding 8 recorded, VERIFIED
// and OPEN, across five builders.
//
// THE ATTACK. Excel, LibreOffice and Google Sheets evaluate a cell that begins
// with `=`, `+`, `-` or `@` as a formula when the file is opened. RFC 4180
// quoting does nothing about this: the parser strips the quotes first, and what
// is inside is then a formula. So free text that a person typed into the product
// — a pet's name, a clinic, a vaccine lot, a case description — becomes code
// running on the machine of whoever opens the export. In this product that
// "whoever" is a government official opening a file we sent them, which is the
// worst possible audience for it.
//
// THE FIX is the standard one and it is boring: prefix a single `'`, which every
// spreadsheet reads as "the rest of this cell is literal text" and does not
// display to the reader.
//
// NUMBERS ARE EXEMPT BY TYPE, NOT BY PATTERN, and that distinction is the only
// subtle thing here. A real `-5` must stay `-5` in a column somebody sums. The
// tempting shortcut is to exempt anything matching "minus then a digit" — but
// `-2+3+cmd|' /C calc'!A0` is the canonical DDE payload and it begins with a
// minus then a digit. A pattern-based exemption waves the attack through. So the
// exemption asks what the value IS (a JavaScript number) rather than what it
// looks like. A string that happens to read "-5" gets the prefix, which is the
// correct trade: it is text in a text column, and the spreadsheet still shows
// it as -5.

/** Leading characters a spreadsheet reads as "this cell is a formula". */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Returns `str` with a leading `'` when a spreadsheet would evaluate it.
 *
 * Pass the ORIGINAL value as `value` so the numeric exemption can be decided by
 * type. Callers that only ever hold strings (the operator-queue builder formats
 * everything for display before it gets here) may pass the string itself.
 */
export function neutralizeCsvFormula(value: unknown, str: string): string {
  if (typeof value === "number" || typeof value === "bigint") return str;
  return FORMULA_LEAD.test(str) ? `'${str}` : str;
}
