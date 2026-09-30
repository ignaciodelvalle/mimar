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
//   - Source-side dedup (2026-09-30, recent-outbreak-signals.ts): an alertable
//       disease whose newest outbreak_signal for this pet is inside the 30-day
//       window, UNTRIAGED (no signal_link) and not outranked by this report's
//       severity raises NOTHING new — it is recorded as `corroborated_signals`
//       on the symptom_observed payload. Anything unclear raises a signal.
//   - For each other alertable reportable disease:
//       insert outbreak_signal (plain, system author) +
//       routeOutbreakSignalNotifications +
//       maybeNotifyOwnersOfPublicAlert
//   - Rabies escalation: rabiesObservationStatus=in_progress + rabies_suspected high_count>=1
//       → route with escalation=true + push urgent owner notification — the
//       push only when reporterRole is `owner` (vet-visit-record: the vet
//       intake path reports as `vet`, and the push is worded for an owner).
//   - pendingNotifications flushed by caller (flushNotifications dep).
//   - Result: { ok: true, symptomEventId, signalEventIds, wasDuplicate }

import { validateEventPayload } from "@/lib/events/event-schemas";
import { homePlace } from "@/lib/events/home-place";
import { maybeNotifyOwnersOfPublicAlert } from "@/lib/infra/owner-disease-alerts";
import { parseDateInput } from "@/lib/utils/format";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { routeOutbreakSignalNotifications } from "../clinical/route-outbreak-signal-notifications";
import type { NewNotification } from "../types";
import { lockAndFindRecentSignals, signalToCorroborate } from "./recent-outbreak-signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateSymptomObservedWriterParams = {
  petId: string;
  petPublicToken: string;
  /** The animal's name, for the owner-facing public-health alert copy. */
  petName: string;
  petSpecies: string;
  petJurisdictionCountry: string;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
  /**
   * The home's catalogue row, read with the names (localidades-por-id D3).
   * Absent = not snapshotted: the signal carries no place and the outbox
   * records none. null = the home names no single row.
   */
  petLocalityId?: string | null;
  petPlaceMethod?: string | null;
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
  /**
   * Who is reporting what they saw (vet-visit-record, 2026-09-29). Defaults to
   * `owner`, the only reporter this writer had until the vet intake path. The
   * owner-facing rabies escalation push ("registraste síntomas…") is sent
   * ONLY when the reporter is the owner: it is addressed to the person who
   * wrote the symptom and worded for an owner, so a vet would receive an
   * urgent notice telling them to go see a vet. The authority routing is
   * unchanged for every reporter.
   */
  reporterRole?: "owner" | "vet" | "witness";
  /**
   * The clinical visit the symptom was observed in. Stamped on the
   * symptom_observed row only; the system outbreak_signal it may raise is not
   * the vet's act and stays outside the visit.
   */
  visitId?: string | null;
  /**
   * The vet's general condition at intake, when this report comes from one.
   * Read only by the dedup guard: poor or critical is a worsening, so the
   * report raises its own signal instead of corroborating an earlier one.
   */
  vetGeneralCondition?: "good" | "fair" | "poor" | "critical" | null;
  now?: Date;
};

export type CreateSymptomObservedWriterResult =
  | {
      ok: true;
      symptomEventId: string;
      signalEventIds: string[];
      /**
       * Existing outbreak_signals this report corroborated instead of
       * duplicating (same pet + disease inside the 30-day window, see
       * recent-outbreak-signals.ts). Empty on a replay.
       */
      corroboratedSignalEventIds: string[];
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
  // No enqueueOutbox (PO S1, 2026-09-26): an owner's symptom is a SIGNAL for
  // the authority, never a legal ENO row — that comes only from a vet/lab.
  repo: Pick<EventsRepository, "insertEvent" | "insertEventIdempotent">;
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
    petName,
    petSpecies,
    petJurisdictionCountry,
    petJurisdictionProvince,
    petJurisdictionLocality,
    petLocalityId,
    petPlaceMethod,
    rabiesObservationStatus,
    recordedByUserId,
    eventAuthorship,
    freeText,
    severity,
    onsetAt,
    clientIdempotencyKey,
    reporterRole = "owner",
    visitId = null,
    vetGeneralCondition = null,
    now = new Date(),
  } = params;

  // The home as the signal's `place` (localidades-por-id D3).
  const signalPlace = homePlace({
    province: petJurisdictionProvince,
    locality: petJurisdictionLocality,
    localityId: petLocalityId,
    placeMethod: petPlaceMethod,
  });

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
  const corroboratedSignalEventIds: string[] = [];
  const pendingNotifications: NewNotification[] = [];

  try {
    await deps.transaction(async (tx) => {
      const rabiesObservationActive = rabiesObservationStatus === "in_progress";
      const planned = alertableDiseases.map((d) => ({
        d,
        isRabiesEscalation:
          rabiesObservationActive && d.disease_code === "rabies_suspected" && d.high_count >= 1,
      }));

      // Source-side dedup (recent-outbreak-signals.ts): a disease that already
      // has a signal for this pet inside the window is CORROBORATED — recorded
      // on this symptom_observed — instead of raising a second signal, a
      // second authority notice and a second count on every /gob surface.
      const recent = await lockAndFindRecentSignals(tx as DbTx, {
        petId,
        diseaseCodes: planned.map((p) => p.d.disease_code),
        now,
      });
      const corroborated: { disease_code: string; outbreak_signal_event_id: string }[] = [];
      const toSignal: typeof planned = [];
      for (const p of planned) {
        const existing = signalToCorroborate(recent, p.d.disease_code, {
          escalation: p.isRabiesEscalation,
          severity,
          vetGeneralCondition,
        });
        if (existing) {
          corroborated.push({
            disease_code: p.d.disease_code,
            outbreak_signal_event_id: existing.id,
          });
        } else {
          toSignal.push(p);
        }
      }

      const symptomPayload = validateEventPayload("symptom_observed", {
        source: "libreta" as const,
        welfare_report_id: null,
        reporter_role: reporterRole,
        free_text: freeText,
        matched_symptom_codes: matchedSymptomCodes,
        alerted_disease_codes: alertableDiseases.map((d) => d.disease_code),
        severity_self_assessed: severity,
        onset_at: onsetAt,
        ...(corroborated.length > 0 ? { corroborated_signals: corroborated } : {}),
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
        ...(visitId ? { visitId } : {}),
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

      corroboratedSignalEventIds.push(...corroborated.map((c) => c.outbreak_signal_event_id));

      // Only the diseases with no signal in the window raise one. A folded
      // disease also skips the owner alert (throttled on the same 30 days) and
      // the rabies push (folded only into an escalation that already sent it).
      for (const { d, isRabiesEscalation } of toSignal) {
        const signalPayload = validateEventPayload("outbreak_signal", {
          source_symptom_event_id: symptomEvent.id,
          // Who described the symptoms: the authority notice reads it, so a
          // vet's intake is not announced as the owner's account.
          reporter_role: reporterRole,
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
          ...(signalPlace ? { place: signalPlace } : {}),
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

        // Build minimal pet shape for routeOutbreakSignalNotifications.
        const fakePet = {
          id: petId,
          publicToken: petPublicToken,
          jurisdictionCountry: petJurisdictionCountry,
          jurisdictionProvince: petJurisdictionProvince,
          jurisdictionLocality: petJurisdictionLocality,
          species: petSpecies,
          ...(petLocalityId !== undefined ? { localityId: petLocalityId } : {}),
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
        // Owner reporter only — see `reporterRole` on the params.
        if (isRabiesEscalation && reporterRole === "owner") {
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
            // The real name: an empty one rendered the alert about nobody
            // (health audit #13, 2026-09-26).
            pet: { id: petId, name: petName },
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

  return { ok: true, symptomEventId, signalEventIds, corroboratedSignalEventIds, wasDuplicate };
}
