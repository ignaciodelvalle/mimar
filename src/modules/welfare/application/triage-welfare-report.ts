// Use-case: triage a welfare report (triaged | invalid | duplicate).
//
// Migrated from app/actions/welfare-triage.ts::triageWelfareReportAction.
// Auth (requireAdminOrGovtOrRedirect + jurisdiction scope) is handled by the caller.
//
// Orchestrates:
//   1. Validate notes length (≥10 chars).
//   2. Load report by ID (caller already verified jurisdiction scope).
//   3. Validate state-machine transition.
//   4. ATOMIC tx:
//      a. updateStatus (+ closedAt/resolutionNotes if terminal)
//      b. insertAudit (welfare_report_triaged)
//      c. closeCase(cancelled) if terminal AND caseId non-null
//   5. Collect reporter notification (non-anon, triaged→"reviewed"; terminal→"closed").
//   6. Return UseCaseResult<void> + pending notifications.

import { statusTransitionAllowed } from "../domain/welfare-status-rules";
import type { WelfareRepository } from "../infrastructure/welfare-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageDecision = "triaged" | "invalid" | "duplicate";

type Actor = {
  user: { id: string };
  profile: { role: "admin" | "govt" };
};

type Deps = {
  repo: Pick<WelfareRepository, "findById" | "updateStatus" | "insertAudit">;
  closeCase: (
    input: { caseId: string; reason: "cancelled" | "resolved"; closedByUserId: string },
    tx: unknown,
  ) => Promise<void>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  actor: Actor;
};

export type TriageWelfareReportInput = {
  welfareReportId: string;
  decision: TriageDecision;
  notes: string;
};

const MIN_NOTES_LEN = 10;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function triageWelfareReport(
  input: TriageWelfareReportInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, closeCase, transaction, actor } = deps;
  const notes = input.notes.trim();

  // 1. Validate notes.
  if (notes.length < MIN_NOTES_LEN) {
    return { ok: false, error: `Las notas deben tener al menos ${MIN_NOTES_LEN} caracteres.` };
  }

  // Validate decision is a valid triage decision (not in_progress etc.)
  if (!["triaged", "invalid", "duplicate"].includes(input.decision)) {
    return { ok: false, error: `La decisión "${input.decision}" no es válida para el triaje.` };
  }

  // 2. Load report.
  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  // 3. State machine.
  if (!statusTransitionAllowed(report.status, input.decision)) {
    return {
      ok: false,
      error: `La denuncia está en estado "${report.status}"; no se puede pasar a "${input.decision}".`,
    };
  }

  const isTerminal = input.decision === "invalid" || input.decision === "duplicate";
  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  // 4. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.updateStatus(
        report.id,
        {
          status: input.decision,
          triagedAt: now,
          triagedByUserId: actor.user.id,
          ...(isTerminal ? { closedAt: now, resolutionNotes: notes } : {}),
        },
        tx as Parameters<typeof repo.updateStatus>[2],
      );

      await repo.insertAudit(
        {
          actorUserId: actor.user.id,
          action: "welfare_report_triaged",
          payload: {
            welfare_report_id: report.id,
            reference_code: report.referenceCode,
            from_status: report.status,
            to_status: input.decision,
            notes,
          },
        },
        tx as Parameters<typeof repo.insertAudit>[1],
      );

      if (isTerminal && report.caseId) {
        await closeCase(
          { caseId: report.caseId, reason: "cancelled", closedByUserId: actor.user.id },
          tx,
        );
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo actualizar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // 5. Build reporter notification (non-anon only).
  if (report.reporterUserId) {
    if (input.decision === "triaged") {
      pendingNotifications.push({
        userId: report.reporterUserId,
        // Routes into the "Denuncias" tab of the notification centre — the tab
        // only renders when its count is > 0, so an uncategorised row is a
        // notification the reporter cannot find (same gap as
        // close-welfare-report.ts, master test CIU §9 #5).
        category: "welfare",
        notificationType: "welfare_report_status_changed",
        title: "Tu denuncia fue revisada",
        body: "Una autoridad revisó tu denuncia y la marcó para seguimiento. Vas a recibir un aviso cuando avance.",
        severity: "info",
        ctaLabel: "Ver mi denuncia",
        ctaUrl: `/denuncias/codigo/${report.referenceCode}`,
      });
    } else {
      pendingNotifications.push({
        userId: report.reporterUserId,
        // Routes into the "Denuncias" tab of the notification centre — the tab
        // only renders when its count is > 0, so an uncategorised row is a
        // notification the reporter cannot find (same gap as
        // close-welfare-report.ts, master test CIU §9 #5).
        category: "welfare",
        notificationType: "welfare_report_status_changed",
        title: "Tu denuncia fue cerrada",
        body:
          input.decision === "duplicate"
            ? "Tu denuncia se marcó como duplicada de otra ya en seguimiento."
            : "Tu denuncia se cerró por falta de elementos para avanzar.",
        severity: "info",
        ctaLabel: "Ver mi denuncia",
        ctaUrl: `/denuncias/codigo/${report.referenceCode}`,
      });
    }
  }

  return { ok: true, value: undefined, notifications: pendingNotifications };
}
