// Use-case: assign a welfare report to the current user.
//
// Migrated from app/actions/welfare-assign.ts::assignWelfareToMeAction.
// Auth (requireAdminOrGovtOrRedirect + jurisdiction scope) handled by caller.
//
// No tx needed — single update. No audit_log (parity: absent in original).
//
// Rules:
//   - If already assigned to a DIFFERENT user → conflict error.
//   - If unassigned or assigned to self → assign to self (idempotent).

import type { WelfareRepository } from "../infrastructure/welfare-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  profile: { role: "admin" | "govt" };
};

type Deps = {
  repo: Pick<WelfareRepository, "findById" | "setAssignee">;
  actor: Actor;
};

export type AssignWelfareInput = {
  welfareReportId: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function assignWelfare(
  input: AssignWelfareInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, actor } = deps;

  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  // Conflict guard: another agent holds this report.
  if (report.assignedToUserId && report.assignedToUserId !== actor.user.id) {
    return { ok: false, error: "Esta denuncia ya está asignada a otro agente." };
  }

  try {
    await repo.setAssignee(input.welfareReportId, actor.user.id);
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo asignar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true, value: undefined, notifications: [] };
}
