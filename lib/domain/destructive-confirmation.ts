// Pure gating helpers for high-impact destructive admin actions (C6, C7).
//
// These encode "fricción proporcional al impacto": certain outcomes/modes fire
// public-health notifications or permanently invalidate records, so the submit
// button must stay disabled until the operator performs an explicit, typed
// acknowledgement. Keeping the gating logic pure makes it unit-testable without
// a DOM.

/** The literal word the operator must type to confirm a positive_rabies close. */
export const RABIES_CONFIRMATION_WORD = "CONFIRMO";

/** The outcome value that triggers public-health notifications on close. */
export const POSITIVE_RABIES_OUTCOME = "positive_rabies";

/**
 * C6 — Whether the "Cerrar observación" submit should be ENABLED.
 *
 * Only `positive_rabies` requires the extra friction: the operator must either
 * type the confirmation word OR tick the public-health acknowledgement box.
 * Every other outcome stays frictionless (returns true as long as a non-empty
 * outcome is selected).
 */
export function canSubmitObservationClose(input: {
  outcome: string;
  typedConfirmation: string;
  acknowledged: boolean;
}): boolean {
  if (input.outcome === "") return false;
  if (input.outcome !== POSITIVE_RABIES_OUTCOME) return true;

  const typedOk = input.typedConfirmation.trim().toUpperCase() === RABIES_CONFIRMATION_WORD;
  return typedOk || input.acknowledged;
}

/**
 * C7 — Whether the moderation "Confirmar" submit should be ENABLED.
 *
 * - "pass" (to triage): only the notes gate (≥ minNotes chars).
 * - "spam": notes gate AND the irreversibility acknowledgement, because
 *   confirming marks the denuncia invalid permanently.
 */
export function canSubmitModeration(input: {
  mode: "none" | "pass" | "spam";
  notes: string;
  acknowledged: boolean;
  minNotes?: number;
}): boolean {
  const minNotes = input.minNotes ?? 10;
  const notesOk = input.notes.trim().length >= minNotes;
  if (input.mode === "pass") return notesOk;
  if (input.mode === "spam") return notesOk && input.acknowledged;
  return false;
}
