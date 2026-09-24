// Finalization input validation — pure function, no DB, no Next.js imports.
// Extracted from app/actions/adoption.ts validation block.

import type { FinalizationInput, FosterRow } from "./types";

export type FinalizationValidationResult = { ok: true } | { ok: false; error: string };

function normalizeDni(raw: string): string {
  return raw.replace(/\D/g, "");
}

function isValidDni(digits: string): boolean {
  return /^\d{7,9}$/.test(digits);
}

/**
 * Validates finalization input for both the DNI path and the foster-shortcut path.
 *
 * @param input - The finalization form data.
 * @param fosterRow - The active foster ownership row for this pet, or null if none.
 *   Only relevant when input.adopterUserId is set (foster-shortcut path).
 */
export function validateFinalizationInput(
  input: FinalizationInput,
  fosterRow: FosterRow | null,
): FinalizationValidationResult {
  // Approved-application path: the adopter identity comes from an approved
  // online application (resolved by the use-case against the event log), so
  // there is no typed DNI / display name to validate here.
  if (input.applicationEventId) {
    return { ok: true };
  }

  // Foster-shortcut path: adopterUserId supplied.
  if (input.adopterUserId) {
    if (!fosterRow || fosterRow.ownerUserId !== input.adopterUserId) {
      return {
        ok: false,
        error:
          "El adoptante del atajo debe ser el tránsito activo de esta mascota. Usá el flujo DNI si es otra persona.",
      };
    }
    return { ok: true };
  }

  // Manual DNI path.
  const raw = input.adopterDni ?? "";
  if (!raw) {
    return { ok: false, error: "Falta el DNI del adoptante." };
  }

  const digits = normalizeDni(raw);
  if (!digits) {
    return { ok: false, error: "DNI inválido (deben ser 7 a 9 dígitos)." };
  }

  if (!isValidDni(digits)) {
    return { ok: false, error: "DNI inválido (deben ser 7 a 9 dígitos)." };
  }

  return { ok: true };
}
