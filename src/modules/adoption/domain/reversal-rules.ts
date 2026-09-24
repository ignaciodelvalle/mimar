// Reversal input validation — pure function, no DB, no Next.js imports.
// Mirrors finalize-rules.ts's shape for the reverse-adoption use-case.
//
// Unlike finalization, reversal has no adopter identity to validate here —
// the reversibility gate (which org finalized it, is it still reversible)
// requires DB reads and lives in the repository, not this pure layer. The
// only caller-supplied input worth a pure rule is the free-text reason.

import type { ReversalInput } from "./types";

export type ReversalValidationResult = { ok: true } | { ok: false; error: string };

const MAX_REASON_LENGTH = 500;

/**
 * Validates reversal input. `reason` is optional (nullable) — the PO
 * semantics do not require a mandatory motivo for this action (Wave 3 rule
 * tier 1: a ConfirmDialog stating the consequence is sufficient weight; no
 * audit-log-required reason field like the tier-2 revoke/reset actions).
 */
export function validateReversalInput(input: ReversalInput): ReversalValidationResult {
  if (input.reason !== null && input.reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      error: `El motivo no puede superar los ${MAX_REASON_LENGTH} caracteres.`,
    };
  }
  return { ok: true };
}
