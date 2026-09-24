// Use-case: enqueue-eno-trigger (spec §F).
//
// Migrated from lib/eno-trigger.ts::processEnoEventTrigger.
// Enqueues a pet event into eno_processing_queue for async fanout.
//
// Contract (spec §F):
//   - sub_kind must be 'disease_diagnosis'
//   - disease_code must resolve to an ENO catalog code (diseaseCodeToEnoCode → isEnoCode)
//   - onConflictDoNothing idempotency — unique index on pet_event_id
//
// TWO CALL MODES (V1-4 / P1-3):
//   1. IN-TRANSACTION (durable): recordDiseaseDiagnosisWriter passes the
//      diagnosis tx as `executor`. The enqueue is then atomic with the event
//      insert — it can never be lost on a crash. In this mode a real DB error
//      MUST propagate so the whole diagnosis tx rolls back; we do NOT swallow.
//      The onConflictDoNothing guard means a duplicate pet_event_id is a quiet
//      no-op (not an error), so legitimate retries never roll back.
//   2. POST-COMMIT (best-effort): legacy callers (backfill script via the
//      @/lib/eno-trigger shim) call without an executor. There the enqueue must
//      NEVER throw — log + swallow so the caller is never blocked. This is the
//      original spec §F contract, preserved for those callers.

import { diseaseCodeToEnoCode, isEnoCode } from "../domain/eno-catalog";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnoTriggerPetEvent = {
  id: string;
  petId: string;
  authorRole: string;
  recordedByUserId: string | null;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
};

type Deps = {
  repo: Pick<SurveillanceRepository, "insertEnoQueueRow">;
  /**
   * Optional transaction executor. When provided, the enqueue runs INSIDE that
   * transaction (durable, atomic with the source event) and DB errors propagate
   * so the caller's tx can roll back. When omitted, the enqueue runs at top
   * level and errors are swallowed (best-effort, never blocks the caller).
   */
  executor?: unknown;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

/**
 * Enqueues an ENO fanout for a clinical_info_logged disease_diagnosis event.
 *
 * Returns silently (no row) when:
 *   - payload is not a disease_diagnosis
 *   - disease_code is not in the ENO catalog
 *   - unique-constraint conflict (event already enqueued — onConflictDoNothing)
 *
 * Error handling depends on the call mode (see file header):
 *   - In-transaction (deps.executor set): DB errors PROPAGATE (roll back the tx).
 *   - Post-commit (no executor): DB errors are logged + swallowed.
 */
export async function enqueueEnoTrigger(petEvent: EnoTriggerPetEvent, deps: Deps): Promise<void> {
  const payload = petEvent.payload;

  // Guard 1: must be a disease diagnosis event.
  if (payload.sub_kind !== "disease_diagnosis") return;

  // Guard 2: must have a string disease_code.
  const rawDiseaseCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
  if (!rawDiseaseCode) return;

  // Guard 3: disease_code must resolve to an ENO catalog entry.
  const diseaseCode = diseaseCodeToEnoCode(rawDiseaseCode);
  if (!isEnoCode(diseaseCode)) return;

  // In-transaction mode: let errors propagate so the diagnosis tx rolls back
  // on a genuine enqueue failure (durability — never silently drop the row).
  if (deps.executor !== undefined) {
    await deps.repo.insertEnoQueueRow(
      petEvent.id,
      deps.executor as Parameters<SurveillanceRepository["insertEnoQueueRow"]>[1],
    );
    return;
  }

  // Post-commit best-effort mode: idempotent insert; swallow to never block.
  try {
    await deps.repo.insertEnoQueueRow(petEvent.id);
  } catch (err) {
    console.error("[enqueue-eno-trigger] enqueue failed (non-fatal):", err);
  }
}
