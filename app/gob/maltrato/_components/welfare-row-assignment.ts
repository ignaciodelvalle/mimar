// Pure assignment-display logic for WelfareDenunciaRow (C6c workqueue
// grammar, plan-maestro-integridad.md §C6). Extracted from the component so
// it's unit-testable without rendering React or mocking next/navigation —
// same rationale as OrgMascotasBulkList's mascota-ctas.tsx split ("pure and
// unit-tested there, independent of this component's server-action imports").
//
// Replaces the old terse "· Asignada" row suffix, which never said WHO or
// whether the case was the viewer's own — a real gap for the inbox grammar's
// "clear ASSIGNMENT state" requirement (Sin asignar / Mía / Asignada a
// {nombre}).

export type AssignmentTone = "open" | "triaged" | "neutral";

export type AssignmentDisplay = {
  tone: AssignmentTone;
  label: string;
};

/**
 * Resolves the row's assignment pill from the report's assignedToUserId, the
 * (already batch-resolved) display name for that id, and the viewing
 * operator's own id.
 *
 * - No assignee            → "Sin asignar" (open/amber — needs action).
 * - Assignee === viewer     → "Mía" (triaged/blue — the viewer's own case).
 * - Assignee !== viewer     → "Asignada a {nombre}" (neutral). Falls back to
 *   "un agente" if the name couldn't be resolved (mirrors the detail page's
 *   assignedToName fallback — a resolution gap should never render blank).
 */
export function resolveAssignmentDisplay(
  assignedToUserId: string | null,
  assignedToName: string | null,
  currentUserId: string,
): AssignmentDisplay {
  if (assignedToUserId === null) {
    return { tone: "open", label: "Sin asignar" };
  }
  if (assignedToUserId === currentUserId) {
    return { tone: "triaged", label: "Mía" };
  }
  return { tone: "neutral", label: `Asignada a ${assignedToName ?? "un agente"}` };
}
