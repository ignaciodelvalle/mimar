// ISO 11784/11785 microchip ID validation, plus the guard that keeps an
// implant event from contradicting the chip the credential already carries.
//
// The ICAR standard mandates a 15-digit numeric identifier. This helper:
//   1. Trims surrounding whitespace.
//   2. Strips separators (spaces, hyphens) that users commonly include.
//   3. Validates that the result is exactly 15 decimal digits.
//
// Returns either { ok: true; normalized: string } or { error: string }.
// The normalized form contains only the 15 digits and is safe to persist.

export type MicrochipValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

/**
 * Validates and normalizes a microchip ID string against ISO 11784/11785.
 *
 * Accepts digits optionally separated by spaces or hyphens.
 * Rejects anything that does not reduce to exactly 15 digits.
 */
export function validateMicrochipId(raw: string): MicrochipValidationResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, error: "El número de microchip no puede estar vacío." };
  }

  // Strip separators: spaces and hyphens are the only allowed non-digit chars.
  const stripped = trimmed.replace(/[\s-]/g, "");

  // After stripping separators, the string must consist of digits only.
  if (!/^\d+$/.test(stripped)) {
    return {
      ok: false,
      error:
        "El microchip solo puede contener dígitos (y separadores opcionales como espacios o guiones).",
    };
  }

  if (stripped.length < 15) {
    return {
      ok: false,
      error: `El microchip debe tener exactamente 15 dígitos (ISO 11784/11785). Ingresaste ${stripped.length}.`,
    };
  }

  if (stripped.length > 15) {
    return {
      ok: false,
      error: `El microchip debe tener exactamente 15 dígitos (ISO 11784/11785). Ingresaste ${stripped.length}.`,
    };
  }

  return { ok: true, normalized: stripped };
}

// ---------------------------------------------------------------------------
// Canonical-chip conflict guard
// ---------------------------------------------------------------------------

/**
 * The one message every `microchip_implanted` writer shows when the number
 * being recorded is not the chip the pet is already bound to.
 *
 * It deliberately does NOT echo the registered number. The atender flow made
 * the same call for the declared number (`attemptedChipMatchesDeclaration`
 * compares inside the SQL predicate and never selects the value) so a signer
 * types what the scanner reads instead of what the screen offers. Echoing it
 * here would hand back, one screen later, exactly what that flow withholds.
 */
export const CHIP_CONFLICTS_WITH_CANONICAL_ERROR =
  "El número no coincide con el microchip registrado para esta mascota. " +
  "Verificá la lectura del escáner. Si el animal tiene un chip nuevo, " +
  "usá «Reemplazar microchip»: ese flujo deja asentado el chip anterior y el motivo del cambio.";

/**
 * Guard every `microchip_implanted` writer must run BEFORE appending the event.
 *
 * WHY THIS EXISTS
 * The pet IS the credential and the chip is what ties it to a body. Until this
 * guard, recording an implant for a pet that already had a canonical chip wrote
 * the event and skipped the canonical row — so the append-only spine could say
 * "a verified vet recorded chip B on this animal" while the ficha, the QR page
 * and every projection kept showing chip A. Nobody was told: not the owner, not
 * the vet who signed, not the funcionario reading the ficha afterwards. The
 * drift harness stayed green too, because `replayPetMicrochip` folds implants
 * earliest-wins and therefore agreed with the stale canonical row.
 *
 * Rejecting is the correct answer for BOTH branches of how this happens:
 *   - mistyped digit → the person holding the animal and the scanner is still
 *     on screen, which is the cheapest possible moment to catch it. Promoting
 *     the typo to canonical instead would let one keystroke rewrite an identity.
 *   - genuinely new chip → `microchip_replaced` is the flow built for it
 *     (reason taxonomy, previous_chip_number in the payload, remediation case
 *     on duplicate/fraud, owner + authority notifications, audit_log row), and
 *     it is reachable by all three actor kinds. Letting the implant path
 *     silently promote the new number would bypass every one of those.
 *
 * Re-submitting the SAME chip stays a success: that is a double-submit or a
 * partial-write re-sync, and the canonical row already says what the event says.
 *
 * @param canonicalChipNumber the pet's active `pet_identifications` code, or
 *   null when the pet carries no chip yet
 * @param attemptedChipNumber the number the actor is trying to record
 * @returns `{ error }` when the two disagree, `null` when the write may proceed
 */
export function checkChipMatchesCanonical(
  canonicalChipNumber: string | null,
  attemptedChipNumber: string,
): { error: string } | null {
  if (canonicalChipNumber === null) return null;
  if (comparableChip(canonicalChipNumber) === comparableChip(attemptedChipNumber)) return null;
  return { error: CHIP_CONFLICTS_WITH_CANONICAL_ERROR };
}

/**
 * Compare chips by their digits, not their typography. "985 121-025 800 001"
 * and "985121025800001" are the same implant, and rejecting the first as a
 * conflict would be a false accusation in front of whoever is holding the
 * animal. Falls back to the trimmed input when the value does not parse, so a
 * non-ISO legacy code still compares against itself.
 */
function comparableChip(raw: string): string {
  const parsed = validateMicrochipId(raw);
  return parsed.ok ? parsed.normalized : raw.trim();
}
