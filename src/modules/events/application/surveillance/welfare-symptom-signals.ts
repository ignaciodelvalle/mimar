// Surveillance leg of a welfare report (denuncia) — PO S7, 2026-09-26.
//
// A denuncia about a registered animal can carry "síntomas observados". Until
// now the text was stored with `matched_symptom_codes: []` and never reached
// the matcher: a complete surveillance gap for third-party and witness
// reports (health audit #10). This runs the SAME matcher the libreta uses and
// raises the SAME outbreak signal — a SIGNAL only:
//
//   - no legal ENO row (PO S1: the legal notification comes from a vet or a
//     lab; the outbox rule declines a matcher signal on its own anyway);
//   - no automatic owner alert (the text is a third party's, possibly
//     anonymous — the owner hears from the authority or the vet, not from an
//     unverified report);
//   - the authority notice is routed where it OCCURRED (PO S10): the report's
//     own place when it gave one, else the animal's home.
//
// The welfare module declares the port (WelfareSymptomSurveillance) and its
// callers wire this implementation, so the welfare use cases stay testable
// without a database.

import { eq } from "drizzle-orm";

import { type db, pets } from "@/db";
import { aggregateDiseaseMatches, matchSymptoms } from "@/lib/domain/symptom-matcher";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { homePlace } from "@/lib/events/home-place";
import type { EventPlace } from "@/lib/events/place-payload";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

import { EventsRepository } from "../../infrastructure/events-repository";
import { routeOutbreakSignalNotifications } from "../clinical/route-outbreak-signal-notifications";
import type { NewNotification } from "../types";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DiseaseMatch = ReturnType<typeof aggregateDiseaseMatches>[number];

export type WelfareSymptomMatch = {
  matchedSymptomCodes: string[];
  alertedDiseaseCodes: string[];
  /** The alertable diseases (DiseaseMatch), carried to emitSignals unchanged. */
  alerts: readonly unknown[];
};

async function readPet(tx: DbTx, petId: string) {
  const [pet] = await tx
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      species: pets.species,
      jurisdictionCountry: pets.jurisdictionCountry,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      localityId: pets.localityId,
      placeMethod: pets.placeMethod,
    })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);
  return pet ?? null;
}

/**
 * The matcher over a denuncia's text, for the animal's species. Alertable =
 * crosses the threshold, is reportable, and is not a vet-only disease (those
 * are raised by a vet or a lab, never by free text). Never throws: a matcher
 * failure records no codes rather than blocking the denuncia.
 */
export async function matchWelfareSymptoms(
  petId: string,
  freeText: string,
  tx: unknown,
): Promise<WelfareSymptomMatch> {
  try {
    const pet = await readPet(tx as DbTx, petId);
    const matched = matchSymptoms(freeText, pet?.species ?? null);
    const alerts = aggregateDiseaseMatches(matched).filter(
      (d) =>
        d.triggers_alert &&
        d.is_reportable &&
        getEnoDisease(diseaseCodeToEnoCode(d.disease_code))?.vetOnly !== true,
    );
    return {
      matchedSymptomCodes: matched.map((m) => m.symptom_code),
      alertedDiseaseCodes: alerts.map((d) => d.disease_code),
      alerts,
    };
  } catch (err) {
    console.error("[welfare] symptom matcher failed (denuncia kept):", err);
    return { matchedSymptomCodes: [], alertedDiseaseCodes: [], alerts: [] };
  }
}

/**
 * One outbreak_signal per alert, inside the denuncia's transaction; the
 * authority notices are returned as a post-commit flush (a notification
 * failure must never roll the denuncia back).
 */
export async function emitWelfareSymptomSignals(
  input: {
    petId: string;
    symptomEventId: string;
    match: WelfareSymptomMatch;
    place: EventPlace | null;
    now: Date;
  },
  tx: unknown,
): Promise<() => Promise<void>> {
  const noop = async () => {};
  if (input.match.alerts.length === 0) return noop;
  const pet = await readPet(tx as DbTx, input.petId);
  if (!pet) return noop;

  const repo = new EventsRepository();
  const pending: NewNotification[] = [];
  const signalPlace =
    input.place ??
    homePlace({
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
      localityId: pet.localityId,
      placeMethod: pet.placeMethod,
    });

  for (const d of input.match.alerts as readonly DiseaseMatch[]) {
    const payload = validateEventPayload("outbreak_signal", {
      triggered_by: "matcher",
      source_symptom_event_id: input.symptomEventId,
      disease_code: d.disease_code,
      disease_label: d.disease_label,
      match_strength: {
        high_count: d.high_count,
        medium_count: d.medium_count,
        low_count: d.low_count,
        matched_symptom_codes: d.matched_symptoms,
      },
      pet_jurisdiction_country: pet.jurisdictionCountry,
      pet_jurisdiction_province: pet.jurisdictionProvince,
      pet_jurisdiction_locality: pet.jurisdictionLocality,
      pet_species: pet.species,
      ...(signalPlace ? { place: signalPlace } : {}),
    });
    const signalEvent = await repo.insertEvent(
      {
        petId: pet.id,
        eventType: "outbreak_signal",
        occurredAt: input.now,
        recordedAt: input.now,
        recordedByUserId: null,
        authorRole: "system",
        authorOrganizationId: null,
        authorVerified: false,
        payload,
      },
      tx as DbTx,
    );
    await routeOutbreakSignalNotifications(
      tx as DbTx,
      {
        signalEvent,
        pet: {
          id: pet.id,
          publicToken: pet.publicToken,
          jurisdictionCountry: pet.jurisdictionCountry,
          jurisdictionProvince: pet.jurisdictionProvince,
          jurisdictionLocality: pet.jurisdictionLocality,
          species: pet.species,
          localityId: pet.localityId,
        },
        disease: {
          disease_code: d.disease_code,
          disease_label: d.disease_label,
          high_count: d.high_count,
          medium_count: d.medium_count,
        },
        origin: "witness",
      },
      pending,
    );
  }

  return async () => {
    if (pending.length === 0) return;
    // Keyed per (signal, recipient, type): the retry cron cannot double-alert.
    await createNotificationsBulk(
      pending.map((n) => ({
        ...n,
        dedupeKey: `event:${n.relatedEventId ?? input.symptomEventId}:${n.userId}:${n.notificationType}`,
      })),
    );
  };
}
