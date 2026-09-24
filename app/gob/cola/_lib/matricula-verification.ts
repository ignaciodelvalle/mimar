// Matrícula verification checklist — the approver's mandatory ticks for a
// role_upgrade_vet approval (UI/UX audit 2026-07: verification, not rubber
// stamp).
//
// PURE module, shared by the server page and the client ReviewActions so the
// checklist copy and the structured decision-note prefix have ONE source.

export const MATRICULA_VERIFICATION_CHECKLIST = [
  {
    key: "formato",
    label: "Verifiqué el formato del número de matrícula",
  },
  {
    key: "registro",
    label: "Consulté el registro oficial de la jurisdicción",
  },
  {
    key: "identidad",
    label: "La identidad del solicitante es consistente con la solicitud",
  },
] as const;

export type MatriculaChecklistKey = (typeof MATRICULA_VERIFICATION_CHECKLIST)[number]["key"];

/**
 * Structured prefix persisted into decision_notes when a matrícula approval is
 * confirmed with the full checklist ticked. Stable, greppable shape — it also
 * lands verbatim in the audit_log payload (approve-request writes notes there)
 * and in the applicant's approval notification body.
 */
export const MATRICULA_VERIFICATION_NOTE =
  "[Verificación de matrícula] Formato verificado; registro oficial consultado; identidad consistente.";

/** Compose the persisted decision notes: structured checklist line first, the
 * operator's free-text notes (if any) below it. */
export function composeMatriculaApprovalNotes(freeNotes: string): string {
  const trimmed = freeNotes.trim();
  return trimmed ? `${MATRICULA_VERIFICATION_NOTE}\n${trimmed}` : MATRICULA_VERIFICATION_NOTE;
}
