// Use-case: recordDiseaseDiagnosis (writer + types)
//
// Migrated from app/actions/events.ts::recordDiseaseDiagnosisWriter +
//   recordDiseaseDiagnosisAction.
//
// Spec 2026-05-19-eno-vet-direct-report-and-owner-alerts §6.
//
// AUTH: VET-ONLY (role=vet + matriculaVerified=true). NO ownership check —
//   the vet can diagnose any pet. Auth guard is at the action layer; this
//   writer is auth-agnostic (exported for integration tests without Next.js).
//
// Parity:
//   - PLAIN insertEvent for clinical_info_logged (sub_kind=disease_diagnosis).
//   - Enqueue outbox for the diagnosis event (ENO SLA).
//   - IF reportable: insert outbreak_signal (system) + outbox + routeSignal + maybeOwnerAlert.
//   - Notifications flushed by caller (flushNotifications dep).
//
// DURABILITY (V1-4 / P1-3): the ENO govt-fanout enqueue (eno_processing_queue
//   row) is now done INSIDE the diagnosis transaction via the enqueueEnoTrigger
//   dep. Previously it ran post-commit, best-effort — if the process died
//   between COMMIT and the post-tx enqueue, the diagnosis was recorded but the
//   govt fan-out row was never created and nothing reconciled it. The
//   eno_processing_queue insert is idempotent (onConflictDoNothing on
//   pet_event_id, unique index from migration 0053), so a retried event write
//   can never create a second queue row — that is what makes the in-tx move
//   safe. The DELIVERY of that row stays async (process-eno-queue cron); only
//   the ENQUEUE is now atomic with the event.

import { validateEventPayload } from "@/lib/events/event-schemas";
import { maybeNotifyOwnersOfPublicAlert } from "@/lib/infra/owner-disease-alerts";
import { findDisease, isReportable } from "@/lib/reference/diseases";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { NewNotification } from "../types";
import { routeOutbreakSignalNotifications } from "./route-outbreak-signal-notifications";

// ---------------------------------------------------------------------------
// Exported types (re-exported from actions.ts for test compatibility)
// ---------------------------------------------------------------------------

export type RecordDiseaseDiagnosisWriterInput = {
  petId: string;
  petName: string;
  petSpecies: string;
  petJurisdictionCountry: string;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
  vetUserId: string;
  vetDisplayName: string;
  diseaseCode: string;
  confirmedByLab: boolean;
  labName: string | null;
  labReportReference: string | null;
  diagnosisDate: Date;
  notes: string | null;
  now?: Date;
};

export type RecordDiseaseDiagnosisWriterResult =
  | {
      ok: true;
      diagnosisEventId: string;
      signalEventId: string | null;
      ownerNotificationsDelivered: number;
    }
  | { ok: false; error: string };

type Deps = {
  repo: Pick<EventsRepository, "insertEvent" | "enqueueOutbox">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  flushNotifications: (pendingNotifications: NewNotification[]) => Promise<void>;
  /**
   * Enqueue the ENO govt-fanout row for this diagnosis event, INSIDE the given
   * transaction (P1-3 durability). Must be idempotent on the pet_event_id so a
   * retried write does not create a second queue row. No-ops when the disease
   * is not ENO-reportable (the underlying use-case applies the catalog guards).
   */
  enqueueEnoTrigger: (
    petEvent: {
      id: string;
      petId: string;
      authorRole: string;
      recordedByUserId: string | null;
      authorOrganizationId: string | null;
      payload: Record<string, unknown>;
    },
    tx: unknown,
  ) => Promise<void>;
};

type DbTx = Parameters<Parameters<typeof import("@/db").db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Core write path for a vet's direct disease diagnosis (ENO spec §6).
 * Exported so integration tests can call it without the Next.js request context.
 * Same logic as the action minus auth + form parsing.
 */
export async function recordDiseaseDiagnosisWriter(
  params: RecordDiseaseDiagnosisWriterInput,
  deps: Deps,
): Promise<RecordDiseaseDiagnosisWriterResult> {
  const disease = findDisease(params.diseaseCode);
  if (!disease) return { ok: false, error: "unknown disease_code" };

  const now = params.now ?? new Date();
  let diagnosisEventId = "";
  let signalEventId: string | null = null;
  let ownerNotificationsDelivered = 0;

  const pendingNotifications: NewNotification[] = [];

  try {
    await deps.transaction(async (tx) => {
      const diagnosisPayload = validateEventPayload("clinical_info_logged", {
        sub_kind: "disease_diagnosis",
        title: `Diagnóstico: ${disease.label}`,
        details: null,
        performed_by: params.vetDisplayName,
        performed_by_user_id: params.vetUserId,
        performed_by_organization_id: null,
        disease_code: params.diseaseCode,
        confirmed_by_lab: params.confirmedByLab,
        lab_name: params.labName,
        lab_report_reference: params.labReportReference,
        diagnosis_date: params.diagnosisDate.toISOString(),
      });

      const diagnosisEvent = await deps.repo.insertEvent(
        {
          petId: params.petId,
          eventType: "clinical_info_logged",
          occurredAt: params.diagnosisDate,
          recordedAt: now,
          recordedByUserId: params.vetUserId,
          authorRole: "vet",
          authorVerified: true,
          authorOrganizationId: null,
          payload: diagnosisPayload,
          notes: params.notes,
        } as Parameters<typeof deps.repo.insertEvent>[0],
        tx as Parameters<typeof deps.repo.insertEvent>[1],
      );
      diagnosisEventId = diagnosisEvent.id;

      // Enqueue outbox row for the diagnosis event (ENO SLA notification).
      await deps.repo.enqueueOutbox(
        tx as Parameters<typeof deps.repo.enqueueOutbox>[0],
        {
          id: diagnosisEvent.id,
          eventType: "clinical_info_logged",
          payload: diagnosisPayload as Record<string, unknown>,
        },
        {
          jurisdictionProvince: params.petJurisdictionProvince,
          jurisdictionLocality: params.petJurisdictionLocality,
        },
      );

      // P1-3 DURABILITY: enqueue the ENO govt-fanout row IN THIS SAME tx, so it
      // can never be lost on a crash between COMMIT and a post-commit enqueue.
      // Idempotent on pet_event_id (onConflictDoNothing) — a rolled-back tx
      // leaves no queue row, and a retried write never duplicates it. The
      // delivery (process-eno-queue cron) stays async.
      await deps.enqueueEnoTrigger(
        {
          id: diagnosisEvent.id,
          petId: params.petId,
          authorRole: "vet",
          recordedByUserId: params.vetUserId,
          authorOrganizationId: null,
          payload: diagnosisPayload as Record<string, unknown>,
        },
        tx,
      );

      if (isReportable(params.diseaseCode)) {
        const signalPayload = validateEventPayload("outbreak_signal", {
          triggered_by: "direct_diagnosis",
          source_symptom_event_id: null,
          source_disease_diagnosis_event_id: diagnosisEvent.id,
          confirmed_by_lab: params.confirmedByLab,
          disease_code: params.diseaseCode,
          disease_label: disease.label,
          match_strength: {
            high_count: 0,
            medium_count: 0,
            low_count: 0,
            matched_symptom_codes: [],
          },
          pet_jurisdiction_country: params.petJurisdictionCountry,
          pet_jurisdiction_province: params.petJurisdictionProvince,
          pet_jurisdiction_locality: params.petJurisdictionLocality,
          pet_species: params.petSpecies,
        });

        const signalEvent = await deps.repo.insertEvent(
          {
            petId: params.petId,
            eventType: "outbreak_signal",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId: null,
            authorRole: "system",
            authorOrganizationId: null,
            authorVerified: false,
            payload: signalPayload,
          } as Parameters<typeof deps.repo.insertEvent>[0],
          tx as Parameters<typeof deps.repo.insertEvent>[1],
        );
        signalEventId = signalEvent.id;

        // Enqueue outbox row for the outbreak_signal event.
        await deps.repo.enqueueOutbox(
          tx as Parameters<typeof deps.repo.enqueueOutbox>[0],
          {
            id: signalEvent.id,
            eventType: "outbreak_signal",
            payload: signalPayload as Record<string, unknown>,
          },
          {
            jurisdictionProvince: params.petJurisdictionProvince,
            jurisdictionLocality: params.petJurisdictionLocality,
          },
        );

        // Build a minimal pet shape for routeOutbreakSignalNotifications.
        const fakePet = {
          id: params.petId,
          publicToken: "",
          jurisdictionCountry: params.petJurisdictionCountry,
          jurisdictionProvince: params.petJurisdictionProvince,
          jurisdictionLocality: params.petJurisdictionLocality,
          species: params.petSpecies,
        };

        await routeOutbreakSignalNotifications(
          tx as DbTx,
          {
            signalEvent,
            // biome-ignore lint/suspicious/noExplicitAny: minimal shape satisfies the helper's Pick
            pet: fakePet as any,
            disease: {
              disease_code: params.diseaseCode,
              disease_label: disease.label,
              high_count: 0,
              medium_count: 0,
            },
            escalation: false,
          },
          pendingNotifications,
        );

        const alertResult = await maybeNotifyOwnersOfPublicAlert(
          {
            pet: { id: params.petId, name: params.petName },
            diseaseCode: params.diseaseCode,
            triggerEventId: signalEvent.id,
          },
          tx as Parameters<typeof maybeNotifyOwnersOfPublicAlert>[1],
        );
        ownerNotificationsDelivered = alertResult.delivered;
      }
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }

  // Flush pending notifications post-tx.
  await deps.flushNotifications(pendingNotifications);

  // NOTE: the ENO govt-fanout enqueue now happens INSIDE the transaction above
  // (deps.enqueueEnoTrigger), not here. There is no longer a post-commit,
  // best-effort enqueue that could be lost on a crash, and therefore no
  // trigger-failure audit_log path — a failed enqueue rolls the diagnosis back
  // with the rest of the tx, surfacing as ok:false. See the P1-3 note above.

  return { ok: true, diagnosisEventId, signalEventId, ownerNotificationsDelivered };
}
