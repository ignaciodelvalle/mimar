// Use-case: createSymptomObserved (writer + types)
//
// Migrated from app/actions/events.ts::createSymptomObservedWriter +
//   createSymptomObservedAction.
//
// Spec: SURVEILLANCE-BRIDGE group — createSymptomObserved.
//
// AUTH: requireAlivePetAccess at the action layer; this writer is auth-agnostic
//   (exported for integration tests without Next.js).
//
// Parity:
//   - symptom_observed: PLAIN insert (NOT idempotent), with matched codes + alerted diseases.
//   - Matcher is defensive: try/catch — failure sets empty results, NEVER blocks the insert.
//   - For each alertable reportable disease:
//       insert outbreak_signal (plain, system author) +
//       enqueueOutbox +
//       routeOutbreakSignalNotifications +
//       maybeNotifyOwnersOfPublicAlert
//   - Rabies escalation: rabiesObservationStatus=in_progress + rabies_suspected high_count>=1
//       → route with escalation=true + push urgent owner notification.
//   - pendingNotifications flushed by caller (flushNotifications dep).
//   - Result: { ok: true, symptomEventId, signalEventIds, wasDuplicate }

import { validateEventPayload } from "@/lib/events/event-schemas";
import { maybeNotifyOwnersOfPublicAlert } from "@/lib/infra/owner-disease-alerts";
import { parseDateInput } from "@/lib/utils/format";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { routeOutbreakSignalNotifications } from "../clinical/route-outbreak-signal-notifications";
import type { NewNotification } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateSymptomObservedWriterParams = {
  petId: string;
  petPublicToken: string;
  petSpecies: string;
  petJurisdictionCountry: string;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
  /** Mirrors pets.rabiesObservationStatus for rabies escalation logic. */
  rabiesObservationStatus: string | null;
  recordedByUserId: string;
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  freeText: string;
  severity: "mild" | "moderate" | "severe" | null;
  onsetAt: string | null;
  /**
   * When provided (non-null), the symptom_observed insert uses insertEventIdempotent
   * for double-submit deduplication (parity with original createSymptomObservedAction).
   * When null/absent, falls back to plain insertEvent (preserves headless writer path).
   */
  clientIdempotencyKey?: string | null;
  now?: Date;
};

export type CreateSymptomObservedWriterResult =
  | {
      ok: true;
      symptomEventId: string;
      signalEventIds: string[];
      /**
       * Did the idempotent insert resolve to an event that ALREADY EXISTED?
       *
       * The same four-line surfacing eb46ac58d gave the six daily writers and
       * a44be2d0e gave the next four: `wasNoop` was read inside the transaction
       * — it is what makes the whole surveillance fan-out skip — and then
       * thrown away at the boundary. Fine while the only caller was a web form
       * that branches on `ok`; not fine for a phone, where "the asiento exists"
       * and "you just created it" are different facts and only the second one
       * should congratulate anybody.
       *
       * ALWAYS `false` on the plain-insert path, which is the honest answer:
       * without a `clientIdempotencyKey` there is no replay to detect and every
       * call appends.
       */
      wasDuplicate: boolean;
    }
  | { ok: false; error: string };

type Deps = {
  repo: Pick<EventsRepository, "insertEvent" | "insertEventIdempotent" | "enqueueOutbox">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  flushNotifications: (pendingNotifications: NewNotification[]) => Promise<void>;
};

type DbTx = Parameters<Parameters<typeof import("@/db").db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Core write path for symptom observation.
 * Exported so integration tests can call it without the Next.js request context.
 * Same logic as createSymptomObservedAction minus auth + form parsing + redirect.
 */
export async function createSymptomObservedWriter(
  params: CreateSymptomObservedWriterParams,
  deps: Deps,
): Promise<CreateSymptomObservedWriterResult> {
  const {
    petId,
    petPublicToken,
    petSpecies,
    petJurisdictionCountry,
    petJurisdictionProvince,
    petJurisdictionLocality,
    rabiesObservationStatus,
    recordedByUserId,
    eventAuthorship,
    freeText,
    severity,
    onsetAt,
    clientIdempotencyKey,
    now = new Date(),
  } = params;

  // Run matcher (defensive — failure must never block the insert).
  let alertableDiseases: import("@/lib/domain/symptom-matcher").DiseaseMatch[] = [];
  let matchedSymptomCodes: string[] = [];
  try {
    const { matchSymptoms, aggregateDiseaseMatches } = await import("@/lib/domain/symptom-matcher");
    const matched = matchSymptoms(freeText, petSpecies);
    matchedSymptomCodes = matched.map((m) => m.symptom_code);
    const aggregated = aggregateDiseaseMatches(matched);
    alertableDiseases = aggregated.filter((d) => d.triggers_alert && d.is_reportable);
  } catch (err) {
    console.error("Symptom matcher failed in writer:", err);
    alertableDiseases = [];
    matchedSymptomCodes = [];
  }

  let symptomEventId = "";
  let wasDuplicate = false;
  const signalEventIds: string[] = [];
  const pendingNotifications: NewNotification[] = [];

  try {
    await deps.transaction(async (tx) => {
      const symptomPayload = validateEventPayload("symptom_observed", {
        source: "libreta" as const,
        welfare_report_id: null,
        reporter_role: "owner" as const,
        free_text: freeText,
        matched_symptom_codes: matchedSymptomCodes,
        alerted_disease_codes: alertableDiseases.map((d) => d.disease_code),
        severity_self_assessed: severity,
        onset_at: onsetAt,
      });

      const symptomEventBase = {
        petId,
        eventType: "symptom_observed",
        // onsetAt is a date-only "YYYY-MM-DD" from <input type="date"> — parse
        // via the noon-UTC anchor. Bare new Date("YYYY-MM-DD") is MIDNIGHT UTC
        // = 21:00 of the PREVIOUS day in AR, shifting the symptom one day back.
        occurredAt: (onsetAt ? parseDateInput(onsetAt) : null) ?? now,
        recordedAt: now,
        recordedByUserId,
        ...eventAuthorship,
        payload: symptomPayload,
      };

      let symptomEvent: { id: string };

      if (clientIdempotencyKey != null) {
        // Idempotent path — parity with original createSymptomObservedAction.
        // When wasNoop=true the submission is a duplicate; skip all signals.
        const { event, wasNoop } = await deps.repo.insertEventIdempotent(
          { ...symptomEventBase, clientIdempotencyKey } as Parameters<
            typeof deps.repo.insertEventIdempotent
          >[0],
          tx as Parameters<typeof deps.repo.insertEventIdempotent>[1],
        );
        symptomEventId = event.id;
        if (wasNoop) {
          wasDuplicate = true;
          return; // early return inside transaction — skip signals
        }
        symptomEvent = event;
      } else {
        // PLAIN insert (NOT idempotent) — original headless writer path.
        symptomEvent = await deps.repo.insertEvent(
          symptomEventBase as Parameters<typeof deps.repo.insertEvent>[0],
          tx as Parameters<typeof deps.repo.insertEvent>[1],
        );
        symptomEventId = symptomEvent.id;
      }

      const rabiesObservationActive = rabiesObservationStatus === "in_progress";

      for (const d of alertableDiseases) {
        const isRabiesEscalation =
          rabiesObservationActive && d.disease_code === "rabies_suspected" && d.high_count >= 1;

        const signalPayload = validateEventPayload("outbreak_signal", {
          source_symptom_event_id: symptomEvent.id,
          disease_code: d.disease_code,
          disease_label: d.disease_label,
          match_strength: {
            high_count: d.high_count,
            medium_count: d.medium_count,
            low_count: d.low_count,
            matched_symptom_codes: d.matched_symptoms,
          },
          pet_jurisdiction_country: petJurisdictionCountry,
          pet_jurisdiction_province: petJurisdictionProvince,
          pet_jurisdiction_locality: petJurisdictionLocality,
          pet_species: petSpecies,
          ...(isRabiesEscalation ? { bite_observation_active: true } : {}),
        });

        // PLAIN insert — outbreak_signal is intentionally non-idempotent.
        const signalEvent = await deps.repo.insertEvent(
          {
            petId,
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
        signalEventIds.push(signalEvent.id);

        // Enqueue outbox row for the outbreak_signal (ENO SLA).
        await deps.repo.enqueueOutbox(
          tx as Parameters<typeof deps.repo.enqueueOutbox>[0],
          {
            id: signalEvent.id,
            eventType: "outbreak_signal",
            payload: signalPayload as Record<string, unknown>,
          },
          {
            jurisdictionProvince: petJurisdictionProvince,
            jurisdictionLocality: petJurisdictionLocality,
          },
        );

        // Build minimal pet shape for routeOutbreakSignalNotifications.
        const fakePet = {
          id: petId,
          publicToken: petPublicToken,
          jurisdictionCountry: petJurisdictionCountry,
          jurisdictionProvince: petJurisdictionProvince,
          jurisdictionLocality: petJurisdictionLocality,
          species: petSpecies,
        };

        await routeOutbreakSignalNotifications(
          tx as DbTx,
          {
            signalEvent,
            // biome-ignore lint/suspicious/noExplicitAny: minimal shape satisfies Pick required by helper
            pet: fakePet as any,
            disease: {
              disease_code: d.disease_code,
              disease_label: d.disease_label,
              high_count: d.high_count,
              medium_count: d.medium_count,
            },
            escalation: isRabiesEscalation,
          },
          pendingNotifications,
        );

        // Rabies escalation: urgent owner notification (spec D5 explicit exception).
        if (isRabiesEscalation) {
          pendingNotifications.push({
            userId: recordedByUserId,
            notificationType: "rabies_observation_escalation_owner",
            severity: "urgent",
            title: "URGENTE — posible signo de rabia en tu mascota",
            body: "Durante el período de observación antirrábica, registraste síntomas compatibles con rabia. CONSULTÁ AL VETERINARIO INMEDIATAMENTE. Si no podés, andá al dispensario antirrábico más cercano o llamá al 107.",
            relatedPetId: petId,
            relatedEventId: signalEvent.id,
            ctaLabel: "Ver mascota",
            ctaUrl: `/mis-mascotas/${petPublicToken}`,
          });
        }

        // Owner-side public-health alert (throttled 30 days per pet+disease).
        await maybeNotifyOwnersOfPublicAlert(
          {
            pet: { id: petId, name: "" },
            diseaseCode: d.disease_code,
            triggerEventId: signalEvent.id,
          },
          tx as Parameters<typeof maybeNotifyOwnersOfPublicAlert>[1],
        );
      }
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }

  // Flush pending notifications post-tx (failure must not roll back the write).
  await deps.flushNotifications(pendingNotifications);

  return { ok: true, symptomEventId, signalEventIds, wasDuplicate };
}
