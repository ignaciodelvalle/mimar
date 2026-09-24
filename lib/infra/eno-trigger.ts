// ENO trigger shim — re-exports processEnoEventTrigger from the surveillance module.
//
// WU-4: lib/eno-trigger.ts is now a thin shim delegating to
// src/modules/surveillance/application/enqueue-eno-trigger.ts.
//
// This shim is used by the backfill script (scripts/backfill-eno-trigger.ts).
// The primary production caller is src/modules/events/application/writers.ts,
// which calls enqueueEnoTrigger directly (in-transaction, P1-3 durability path).
// This shim wires the post-commit best-effort path for legacy/script callers.

import { enqueueEnoTrigger } from "@/src/modules/surveillance/application/enqueue-eno-trigger";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";

const repo = new SurveillanceRepository();

/**
 * Enqueues an ENO fanout for a clinical_info_logged disease_diagnosis event.
 * Delegates to the surveillance module use-case with the real SurveillanceRepository.
 *
 * Returns silently when:
 *   - payload is not a disease_diagnosis
 *   - disease_code is not in the ENO catalog
 *   - unique-constraint conflict (event already enqueued — no-op)
 *
 * Never throws — maintains the original contract for events.ts callers.
 */
export async function processEnoEventTrigger(petEvent: {
  id: string;
  petId: string;
  authorRole: string;
  recordedByUserId: string | null;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  return enqueueEnoTrigger(petEvent, { repo });
}
