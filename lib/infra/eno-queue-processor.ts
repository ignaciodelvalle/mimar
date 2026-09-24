// ENO queue processor shim — re-exports processEnoQueueBatch from the surveillance module.
//
// WU-4: lib/eno-queue-processor.ts is now a thin shim delegating to
// src/modules/surveillance/application/process-eno-queue-batch.ts.
//
// The cron route at app/api/cron/process-eno-queue/route.ts continues importing
// from @/lib/eno-queue-processor and sees no API change. The integration test
// at __tests__/eno-trigger.test.ts also imports from here.
//
// Real logic lives in the module use-case. This shim wires the production deps
// (SurveillanceRepository + DB lookups + auditLog) and calls the use-case.
//
// PARITY QUIRKS preserved (spec §G):
//   - BATCH_SIZE=50, oldest first.
//   - Owner notification only if !stigmaSensitive AND ownerUserId !== null.
//   - Per-row try/catch via use-case internals.
//
// ONE PARITY QUIRK DELIBERATELY DROPPED (2026-08-17): the eno_notification_emitted
// audit row used to be conditional on vetUserId. That made the trace of the
// highest-legal-risk route in the system disappear exactly when the diagnosis had
// no identified clinician — so a fan-out to nobody could be perfectly invisible.
// The row is now unconditional with a NULL actor (the FK is nullable by design).

import { and, eq, isNull } from "drizzle-orm";

import { type AuditLogAction, auditLog, db, ownerships, pets } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { processEnoQueueBatch as _processEnoQueueBatch } from "@/src/modules/surveillance/application/process-eno-queue-batch";
import { getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";

// Re-export the result type for callers that imported it from here.
export type { EnoBatchResult } from "@/src/modules/surveillance/application/process-eno-queue-batch";

const repo = new SurveillanceRepository();

/**
 * Drain the ENO processing queue.
 * Delegates to the surveillance module use-case with all production DB deps wired.
 */
export async function processEnoQueueBatch() {
  return _processEnoQueueBatch({
    repo,

    getPet: async (petId: string) => {
      const [row] = await db
        .select({
          id: pets.id,
          name: pets.name,
          publicToken: pets.publicToken,
          jurisdictionProvince: pets.jurisdictionProvince,
          jurisdictionLocality: pets.jurisdictionLocality,
        })
        .from(pets)
        .where(eq(pets.id, petId))
        .limit(1);
      return row ?? null;
    },

    getOwnership: async (petId: string) => {
      const [row] = await db
        .select({ ownerUserId: ownerships.ownerUserId })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      return row?.ownerUserId ? { ownerUserId: row.ownerUserId } : null;
    },

    getDisease: async (code: string) => {
      return getEnoDisease(code);
    },

    // The mandatory-reportable-disease route (Ley 15.465) gets the SAME fallback
    // as everything else (2026-08-17). This used to query govt_assignments raw:
    // govt-only, no admin fallback, and a subsumption of its own that knew the
    // `locality = ''` sentinel but not CABA's INDEC whole-city form. A rabies /
    // leptospirosis / brucelosis diagnosis in an unseeded locality produced
    // targetsCount = 0, the queue row was marked processed, and the disease's
    // notifyHours SLA was satisfied on paper with nobody in government aware.
    //
    // findAuthoritiesForJurisdiction is govt-first, active-institutional-admin
    // fallback, one subsumption predicate — and it writes the
    // notification_fanout_empty audit row when even the fallback is empty.
    getGovtTargets: async (province: string, locality: string) => {
      const userIds = await findAuthoritiesForJurisdiction(
        { province, locality },
        { route: "eno_disease_diagnosis" },
      );
      return userIds.map((userId) => ({ userId }));
    },

    insertAuditLog: async (row: {
      actorUserId: string | null;
      action: string;
      payload: Record<string, unknown>;
    }) => {
      await db.insert(auditLog).values({
        actorUserId: row.actorUserId,
        action: row.action as AuditLogAction,
        payload: row.payload,
      });
    },
  });
}
