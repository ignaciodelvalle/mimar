// Use-case: unassign a welfare report.
//
// Migrated from app/actions/welfare-assign.ts::unassignWelfareAction.
// Auth (requireAdminOrGovtOrRedirect + jurisdiction scope) handled by caller.
//
// No tx needed — single update. No audit_log (parity: absent in original).
//
// Rules:
//   - Report must be assigned.
//   - Only the current assignee OR an admin can unassign.
//   - A different govt user cannot unassign another govt's report.

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

export type UnassignWelfareInput = {
  welfareReportId: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function unassignWelfare(
  input: UnassignWelfareInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, actor } = deps;

  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  if (!report.assignedToUserId) {
    return { ok: false, error: "La denuncia no está asignada." };
  }

  // Only the assignee or an admin can unassign.
  if (actor.profile.role !== "admin" && report.assignedToUserId !== actor.user.id) {
    return {
      ok: false,
      error: "Solo el agente asignado o un administrador puede desasignar.",
    };
  }

  try {
    await repo.setAssignee(input.welfareReportId, null);
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo desasignar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true, value: undefined, notifications: [] };
}
