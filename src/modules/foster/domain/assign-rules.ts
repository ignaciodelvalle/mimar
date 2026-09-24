// Foster assign + end domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/foster.ts validation/mapping blocks.

import {
  type AssignFosterInput,
  type DomainResult,
  END_FOSTER_UI_REASONS,
  END_REASON_TO_CLOSED_REASON,
  type EndFosterUIReason,
} from "./types";

// ---------------------------------------------------------------------------
// Assign foster
// ---------------------------------------------------------------------------

/**
 * Parses the raw expectedWeeks form value.
 * - Empty / whitespace → null.
 * - Non-numeric → parseInt returns NaN → Math.max(0, 0) = 0.
 * - Negative → clamped to 0.
 */
export function parseExpectedWeeks(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return Math.max(0, Number.parseInt(trimmed, 10) || 0);
}

export type AssignFosterValidated = {
  fosterUserId: string;
  expectedWeeks: number | null;
  notes: string | null;
};

export function validateAssignFosterInput(
  input: AssignFosterInput,
): DomainResult<AssignFosterValidated> {
  if (!input.fosterUserId.trim()) {
    return { ok: false, error: "Elegí un voluntario para el tránsito." };
  }

  const expectedWeeks = parseExpectedWeeks(input.expectedWeeksRaw);

  return {
    ok: true,
    value: {
      fosterUserId: input.fosterUserId.trim(),
      expectedWeeks,
      notes: input.notes,
    },
  };
}

// ---------------------------------------------------------------------------
// End foster
// ---------------------------------------------------------------------------

/**
 * Resolves the end-foster reason from raw form input.
 * If the raw value is not in the UI whitelist, defaults to 'returned'.
 * Programmatic-only reasons (pet_died, adoption) are silently rejected here.
 */
export function resolveEndFosterReason(reasonRaw: string): EndFosterUIReason {
  return END_FOSTER_UI_REASONS.includes(reasonRaw as EndFosterUIReason)
    ? (reasonRaw as EndFosterUIReason)
    : "returned";
}

/**
 * Maps a UI end-foster reason to the case closed_reason.
 * early_return_by_foster → cancelled (the engagement didn't run its course).
 * All other reasons → resolved.
 */
export function endReasonToClosedReason(reason: EndFosterUIReason): "resolved" | "cancelled" {
  return END_REASON_TO_CLOSED_REASON[reason];
}
