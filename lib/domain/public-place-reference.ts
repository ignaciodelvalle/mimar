/**
 * What a stranger reads as "where it was last seen".
 *
 * THE DECISION (PO, 2026-09-16) and the argument behind it, which is his: by the
 * time somebody reads this, THE ANIMAL HAS MOVED. The line is not a statement of
 * where the animal is, it is where to start looking. Exactness buys nothing
 * against that, and it costs something real — the place a pet went missing is
 * very often its own doorstep, so a street number published on an open page is
 * the owner's home address published on an open page.
 *
 * WHY THIS LIVES AT PUBLICATION AND NOT AT CAPTURE. The full address and the
 * coordinates keep doing their jobs: the coordinate routes the case and alerts
 * organisations by proximity, and the operator working the case sees the address.
 * None of that reaches the public credential. Capture wide, publish narrow — the
 * same shape this codebase already uses for every other piece of personal data,
 * rather than degrading the record itself to protect one surface.
 *
 * WHAT IT DOES, precisely: removes the house number and keeps everything else.
 * "Av. Rivadavia 1234, Balvanera, CABA" becomes "Av. Rivadavia, Balvanera,
 * CABA" — still a landmark somebody can walk to, no longer a door.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not reduce the text to a locality.
 * A search party told "Balvanera" has forty blocks and no starting point, and
 * the native app's own field ("la esquina del kiosco") is more specific than
 * that — coarsening the web past the app would swap one inconsistency for
 * another.
 *
 * IT IS NOT A SANITISER. The text can be free prose typed on a phone, and
 * nothing here validates content; it only drops a number when the shape is an
 * address. Whether the owner consented to publishing anything at all is decided
 * elsewhere and earlier (`disclose_last_location_when_lost`, which defaults OFF),
 * and this never runs when that is false.
 */

/**
 * A street number: digits at the END of the first comma-separated segment,
 * optionally with a `bis` or a letter suffix. Anchored to the end on purpose —
 * a digit elsewhere is as likely to belong to a place's name ("Barrio 17 de
 * Agosto") as to a door.
 *
 * TWO DIGITS MINIMUM, and the first version of this had one. "Ruta 8" and
 * "Sarmiento 450" are the same shape (a word, then a number, then the comma),
 * so the pattern cannot tell them apart by structure — and a rule that erased
 * the 8 would strip a ROUTE OF ITS NAME while trying to remove a door. Two
 * digits is not a proof, it is where the two populations stop overlapping much:
 * national and provincial routes are mostly one to three digits and doors are
 * mostly three or four, so the floor costs a handful of two-digit doors in small
 * towns and saves every single-digit route. The keyword list below covers the
 * rest.
 */
const HOUSE_NUMBER = /\s+\d{2,}\s*(?:bis)?[a-dA-D]?\s*$/i;

/**
 * Segments whose number IS the name, so the number stays whatever its length.
 * A road is a landmark; a road without its number is not a landmark at all.
 */
const NUMBER_IS_THE_NAME = /^\s*(?:ruta|rn|rp|autopista|autov[ií]a|acceso|km|kil[oó]metro)\b/i;

export function publicPlaceReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;

  const comma = text.indexOf(",");
  const head = comma === -1 ? text : text.slice(0, comma);
  const tail = comma === -1 ? "" : text.slice(comma);

  const trimmedHead = NUMBER_IS_THE_NAME.test(head)
    ? head.trim()
    : head.replace(HOUSE_NUMBER, "").trim();
  // A head that was ONLY a number ("1234, Balvanera") leaves nothing to stand
  // on, so the segment goes rather than publishing a leading comma. It is
  // matched separately because HOUSE_NUMBER requires whitespace before the
  // digits and a bare number has none.
  if (trimmedHead === "" || /^\d+\s*(?:bis)?[a-dA-D]?$/i.test(trimmedHead)) {
    return tail.replace(/^,\s*/, "").trim() || null;
  }

  return `${trimmedHead}${tail}`.trim();
}
