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

/**
 * The sentence the org member reads when custody is no longer with the adopter
 * of the adoption they are trying to reverse. One constant for the two places
 * that can discover it: the reversibility gate (a read) and the guarded close
 * of the adopter's owner row inside the reversal transaction (a write that
 * matched nothing because another hand-off closed that row first).
 */
export const ADOPTER_NO_LONGER_HOLDS_ERROR =
  "La mascota ya no está bajo la custodia del adoptante de esta adopción — no se puede revertir.";

/**
 * A refusal decided INSIDE the reversal transaction. The use-case surfaces its
 * message verbatim instead of wrapping it in "No se pudo revertir…": it is an
 * answer about the pet, not an internal failure, and retrying cannot change it.
 */
export class ReversalRefused extends Error {
  readonly name = "ReversalRefused";
}
