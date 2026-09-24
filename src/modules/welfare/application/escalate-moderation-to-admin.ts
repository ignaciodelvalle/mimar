// Use-case: escalate a flagged welfare report to the national admin queue.
//
// Phase 2 of jurisdiction-scoped denuncia moderation
// (dim-interno:docs/design/handoffs/2026-07-07-govt-jurisdiction-moderation-sdd.md).
//
// A jurisdiction govt that does not want to approve (pass-to-triage) or reject
// (confirm-as-spam) a flagged denuncia — because it is cross-jurisdiction,
// ambiguous, or simply not their call — hands it back to the national admin.
// Auth (requireDenunciaModerationPrincipal + jurisdiction scope) handled by caller.
//
// Escalation is an APPEND-ONLY decision, NOT a resolution:
//   - moderationResolvedAt stays NULL → the report remains in the admin queue.
//   - moderationEscalatedAt is set → the report leaves the govt actionable queue
//     and carries an "escalated by govt" signal.
//
// Orchestrates:
//   1. Validate notes (>=10 chars) — the motivo is mandatory.
//   2. Load report — must exist, be flagged, be moderation-pending, not already
//      escalated.
//   3. ATOMIC tx:
//      a. updateStatus (set moderationEscalatedAt + by)
//      b. insertAudit (welfare_report_escalated_to_admin) with flag_reasons_snapshot
//   4. Return UseCaseResult<void> (no notifications).

import type { WelfareRepository } from "../infrastructure/welfare-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: Pick<WelfareRepository, "findById" | "updateStatus" | "insertAudit">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  actor: Actor;
};

export type EscalateModerationToAdminInput = {
  welfareReportId: string;
  notes: string;
};

const MIN_NOTES_LEN = 10;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function escalateModerationToAdmin(
  input: EscalateModerationToAdminInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction, actor } = deps;
  const notes = input.notes.trim();

  // 1. Validate notes.
  if (notes.length < MIN_NOTES_LEN) {
    return { ok: false, error: `Las notas deben tener al menos ${MIN_NOTES_LEN} caracteres.` };
  }

  // 2. Load report.
  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };
  if (!report.flaggedAt) return { ok: false, error: "La denuncia no está flagged." };
  if (report.moderationResolvedAt) return { ok: false, error: "Ya se resolvió la moderación." };
  if (report.moderationEscalatedAt) {
    return { ok: false, error: "La denuncia ya fue escalada a la administración." };
  }

  const now = new Date();

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.updateStatus(
        report.id,
        {
          moderationEscalatedAt: now,
          moderationEscalatedByUserId: actor.user.id,
        },
        tx as Parameters<typeof repo.updateStatus>[2],
      );

      await repo.insertAudit(
        {
          actorUserId: actor.user.id,
          action: "welfare_report_escalated_to_admin",
          payload: {
            welfare_report_id: report.id,
            reference_code: report.referenceCode,
            flag_reasons_snapshot: report.flagReasons,
            notes,
          },
        },
        tx as Parameters<typeof repo.insertAudit>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo escalar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true, value: undefined, notifications: [] };
}
