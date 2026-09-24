// Use-case: process-eno-queue-batch (spec §G).
//
// Migrated from lib/eno-queue-processor.ts::processEnoQueueBatch.
// Drains eno_processing_queue rows in status='pending' order by queued_at.
// For each row: resolve disease → govt fanout → owner notif → audit_log → mark processed.
//
// Auth: none — cron-only. Route guard (Bearer) lives at the route layer.
//
// PARITY QUIRKS (spec §G):
//   - BATCH_SIZE=50, oldest first.
//   - audit_log (eno_notification_emitted) was CONDITIONAL on vetUserId. NO LONGER
//     (2026-08-17) — see the comment at step 6 for why that quirk had to die.
//   - owner notification ONLY if !stigmaSensitive AND ownerUserId !== null.
//   - processOne returns false → mark processed with lastError "skipped".
//   - Throw → markEnoFailed. retryCount≥2 → status='failed'; else stays pending.
//   - Per-row try/catch isolates failures.

import { type EnoDisease, diseaseCodeToEnoCode, isEnoCode } from "../domain/eno-catalog";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnoBatchResult = {
  scannedAt: Date;
  processed: number;
  failed: number;
  skipped: number;
};

export type EnoBatchDeps = {
  repo: Pick<
    SurveillanceRepository,
    | "pickPendingBatch"
    | "findEnoEventRow"
    | "markEnoProcessed"
    | "markEnoFailed"
    | "insertNotifications"
  >;
  /** Load a pet row by its ID. */
  getPet: (petId: string) => Promise<{
    id: string;
    name: string;
    publicToken: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  } | null>;
  /** Load active ownership (owner userId) for a pet. */
  getOwnership: (petId: string) => Promise<{ ownerUserId: string } | null>;
  /** Resolve a disease code to an EnoDisease record. */
  getDisease: (code: string) => Promise<EnoDisease | null>;
  /**
   * Resolve the authorities to notify for a province+locality. Production wires
   * this to findAuthoritiesForJurisdiction — govt-first with the institutional
   * admin fallback — so this route is no longer the one path with no fallback.
   */
  getGovtTargets: (province: string, locality: string) => Promise<{ userId: string }[]>;
  /** Write an audit_log row. Actor is nullable: a diagnosis can have no identified clinician. */
  insertAuditLog: (row: {
    actorUserId: string | null;
    action: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
};

const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function processEnoQueueBatch(deps: EnoBatchDeps): Promise<EnoBatchResult> {
  const scannedAt = new Date();
  const batch = await deps.repo.pickPendingBatch(BATCH_SIZE);

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of batch) {
    try {
      const handled = await processOne(row.petEventId, deps);
      if (handled) {
        await deps.repo.markEnoProcessed(row.id);
        processed += 1;
      } else {
        // Event row missing or not eligible — close out so we don't retry forever.
        await deps.repo.markEnoProcessed(row.id);
        skipped += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      await deps.repo.markEnoFailed(row.id, message);
      failed += 1;
    }
  }

  return { scannedAt, processed, failed, skipped };
}

// ---------------------------------------------------------------------------
// processOne — single row fanout
// Returns true when fanout was performed, false when the event is missing/ineligible.
// ---------------------------------------------------------------------------

async function processOne(petEventId: string, deps: EnoBatchDeps): Promise<boolean> {
  // 1. Load the event row.
  const eventRow = await deps.repo.findEnoEventRow(petEventId);
  if (!eventRow) return false;

  const payload = eventRow.payload as Record<string, unknown>;
  if (payload.sub_kind !== "disease_diagnosis") return false;

  const rawDiseaseCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
  if (!rawDiseaseCode) return false;

  const diseaseCode = diseaseCodeToEnoCode(rawDiseaseCode);
  if (!isEnoCode(diseaseCode)) return false;

  const disease = await deps.getDisease(diseaseCode);
  if (!disease) return false;

  const diagnosisDate =
    typeof payload.diagnosis_date === "string" ? payload.diagnosis_date : new Date().toISOString();

  // 2. Load pet.
  const petRow = await deps.getPet(eventRow.petId);
  if (!petRow) return false;

  // 3. Owner lookup.
  const ownershipRow = await deps.getOwnership(eventRow.petId);
  const ownerUserId = ownershipRow?.ownerUserId ?? null;

  const vetUserId = eventRow.recordedByUserId;
  const vetOrgId = eventRow.authorOrganizationId;

  const province = petRow.jurisdictionProvince ?? "";
  const locality = petRow.jurisdictionLocality ?? "";

  // 4. Govt fanout.
  const targets = await deps.getGovtTargets(province, locality);
  const targetsCount = targets.length;

  const notifications: Parameters<typeof deps.repo.insertNotifications>[0] = [];

  if (targetsCount > 0) {
    for (const t of targets) {
      notifications.push({
        userId: t.userId,
        notificationType: "eno_disease_diagnosis",
        title: `ENO: ${disease.label} — ${petRow.name}`,
        body: `Diagnóstico de ${disease.label} reportado en ${
          petRow.jurisdictionLocality ??
          petRow.jurisdictionProvince ??
          "jurisdicción no especificada"
        }. SLA: ${disease.notifyHours}h.`,
        severity: disease.severity === "critical" ? ("urgent" as const) : ("warning" as const),
        relatedPetId: petRow.id,
        relatedEventId: eventRow.id,
        category: "health",
        // Govt recipient cannot open /mis-mascotas; surveillance hub is their surface.
        ctaLabel: "Ver vigilancia",
        ctaUrl: "/gob/vigilancia",
      });
    }
  }

  // 5. Owner notification (ONLY if !stigmaSensitive AND ownerUserId present).
  const ownerWasNotified = !disease.stigmaSensitive && ownerUserId !== null;
  if (ownerWasNotified && ownerUserId) {
    notifications.push({
      userId: ownerUserId,
      notificationType: "eno_pet_disease_diagnosis",
      title: `Tu mascota ${petRow.name}: ${disease.label}`,
      body: `El veterinario registró un diagnóstico de ${disease.label} para ${petRow.name}. Consultá con tu veterinario para los próximos pasos.`,
      severity: disease.severity === "critical" ? ("urgent" as const) : ("warning" as const),
      relatedPetId: petRow.id,
      relatedEventId: eventRow.id,
      category: "health",
      ctaLabel: "Ver mascota",
      ctaUrl: `/mis-mascotas/${petRow.publicToken}`,
    });
  }

  if (notifications.length > 0) {
    await deps.repo.insertNotifications(notifications);
  }

  // 6. Audit log — UNCONDITIONAL since 2026-08-17.
  //
  // It used to be gated on vetUserId (spec §G listed that as a parity quirk).
  // The consequence: for a diagnosis with no identified clinician, the ONLY
  // record that the mandatory notification had been attempted at all was
  // skipped — so `targets_count: 0` on the highest-legal-risk route in the
  // system (Ley 15.465) could be perfectly invisible while the queue row was
  // marked processed and the notifyHours SLA was satisfied on paper.
  //
  // audit_log.actor_user_id is nullable by design (FK ON DELETE SET NULL,
  // migration 0080) precisely for system writers with no human actor.
  await deps.insertAuditLog({
    actorUserId: vetUserId ?? null,
    action: "eno_notification_emitted",
    payload: {
      disease_code: diseaseCode,
      disease_severity: disease.severity,
      pet_id: petRow.id,
      targets_count: targetsCount,
      owner_was_notified: ownerWasNotified,
      legal_anchor: disease.legalAnchor,
      diagnosis_date: diagnosisDate,
      vet_org_id: vetOrgId,
    },
  });

  return true;
}
