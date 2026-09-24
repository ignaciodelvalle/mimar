// Eligibility input validation — pure function, no DB, no Next.js imports.
// Extracted from app/actions/adoption-eligibility.ts validation block.

import { INELIGIBLE_REASONS } from "./types";
import type { EligibilityInput } from "./types";

export type EligibilityValidationResult = { ok: true } | { ok: false; error: string };

export function validateEligibilityInput(input: EligibilityInput): EligibilityValidationResult {
  if (!input.eligible && !input.ineligibleReason) {
    return { ok: false, error: "Indicá la razón cuando la mascota no es apta para adopción." };
  }

  if (input.eligible && input.ineligibleReason) {
    return {
      ok: false,
      error: "No corresponde razón cuando la mascota es apta para adopción.",
    };
  }

  if (
    input.ineligibleReason &&
    !(INELIGIBLE_REASONS as readonly string[]).includes(input.ineligibleReason)
  ) {
    return { ok: false, error: "Razón inválida." };
  }

  if (
    input.ineligibleReason === "other" &&
    (input.ineligibleReasonNotes == null || input.ineligibleReasonNotes.trim().length === 0)
  ) {
    return { ok: false, error: "Cuando la razón es 'other' necesitamos una nota descriptiva." };
  }

  if (input.ineligibleUntilIso) {
    const parsed = new Date(input.ineligibleUntilIso);
    if (!Number.isFinite(parsed.getTime())) {
      return { ok: false, error: "Fecha 'ineligibleUntil' inválida." };
    }
  }

  return { ok: true };
}
