// Use-case: pass a flagged welfare report back to triage (unflag).
//
// Migrated from app/actions/welfare-moderation.ts::passWelfareToTriageAction.
// Auth (requireAdminOrRedirect — admin-ONLY) handled by caller.
//
// Orchestrates:
//   1. Validate notes (≥10 chars).
//   2. Load report — must exist, be flagged, be moderation-pending.
//   3. ATOMIC tx:
//      a. updateStatus (set moderationResolvedAt + by)
//      b. insertAudit (welfare_report_unflagged) with flag_reasons_snapshot
//   4. Return UseCaseResult<void> (no notifications on unflag).

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

export type PassWelfareToTriageInput = {
  welfareReportId: string;
  notes: string;
};

const MIN_NOTES_LEN = 10;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function passWelfareToTriage(
  input: PassWelfareToTriageInput,
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

  const now = new Date();

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.updateStatus(
        report.id,
        {
          moderationResolvedAt: now,
          moderationResolvedByUserId: actor.user.id,
        },
        tx as Parameters<typeof repo.updateStatus>[2],
      );

      await repo.insertAudit(
        {
          actorUserId: actor.user.id,
          action: "welfare_report_unflagged",
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
      error: `No se pudo desflagear: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true, value: undefined, notifications: [] };
}
