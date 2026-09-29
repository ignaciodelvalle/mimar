// Use-case: recordConditionAtIntake (vet-visit-record, 2026-09-29)
//
// The state the pet arrived in, written by a verified vet at the start of a
// clinical visit. Auth — "a member holding clinical write capability at the
// visit's organization" — is the caller's (the Atender action resolves the
// pet and the signer tier). This use-case refuses what it can see for itself:
// an author that is not a VERIFIED vet writing FOR the visit's organization.
//
// ONE TRANSACTION, one visit, one idempotency key:
//   1. condition_at_intake_recorded — at most one per visit. A second one is
//      refused with a sentence (corrections are event_amended, never a second
//      intake); a replay of the same write (same clientIdempotencyKey) is a
//      no-op that reports the original. The partial unique index
//      pet_events_one_intake_per_visit is the backstop under concurrency.
//   2. weight_recorded, when the vet weighed the animal — its own event, so
//      there is ONE weight source; the pet's weight cache is re-derived from
//      the spine.
//   3. symptom_observed, ONLY when the motivo de consulta + hallazgos match
//      the symptom catalogue (matchSymptoms): reported as `vet`, through the
//      same writer an owner's symptom goes through, inside this transaction.
//      Its outbreak signals route to the authority as always; its
//      notifications are returned for the caller to flush after commit.
// Every vet row carries the visit's id explicitly and shares the caller's
// clientIdempotencyKey: the idempotency index is per (pet, event_type, key),
// so one key covers the set and an offline client can replay it whole.
//
// Order inside the visit is a data property, not a gate: an intake recorded
// after a vaccine in the same visit is accepted (design decision; PO default).

import { matchSymptoms } from "@/lib/domain/symptom-matcher";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { matchesDbError } from "@/lib/infra/db-errors";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { createSymptomObservedWriter } from "../surveillance/symptom-observed-use-case";
import type { NewNotification, RecordedEvent, UseCaseResult } from "../types";
import type { ConditionAtIntakeFields } from "./condition-at-intake-form";

export const INTAKE_EVENT_TYPE = "condition_at_intake_recorded";

export type RecordConditionAtIntakeInput = {
  /** What the symptom writer needs to route a signal, when the text matches. */
  pet: {
    id: string;
    publicToken: string;
    name: string;
    species: string;
    jurisdictionCountry: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    localityId?: string | null;
    placeMethod?: string | null;
    rabiesObservationStatus: string | null;
  };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  /** The open visit this intake belongs to (ensureOpenVisit). */
  visit: { id: string; organizationId: string; modality: "clinic" | "home" };
  occurredAt: Date;
  fields: ConditionAtIntakeFields;
};

export type RecordedIntake = RecordedEvent & {
  /** The sibling weight_recorded, when the vet weighed the animal. */
  weightEventId: string | null;
  /** The vet-reported symptom_observed, when the text matched the catalogue. */
  symptomEventId: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    "insertEvent" | "insertEventIdempotent" | "findVisitEventOfType" | "updateWeightProjection"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export const INTAKE_NOT_A_VERIFIED_VET =
  "Solo un veterinario con matrícula validada de esta organización puede registrar el estado al ingreso.";
export const INTAKE_ALREADY_RECORDED =
  "Esta atención ya tiene el estado al ingreso registrado. Si hay que corregirlo, hacelo con una enmienda.";

type Executor = Parameters<EventsRepository["insertEventIdempotent"]>[1];

/** The partial unique index (migration 0274) that holds one intake per visit. */
export const ONE_INTAKE_PER_VISIT_INDEX = "pet_events_one_intake_per_visit";

export async function recordConditionAtIntake(
  input: RecordConditionAtIntakeInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedIntake>> {
  const { pet, user, eventAuthorship, visit, occurredAt, fields } = input;
  const { repo, transaction } = deps;

  if (
    eventAuthorship.authorRole !== "vet" ||
    !eventAuthorship.authorVerified ||
    eventAuthorship.authorOrganizationId !== visit.organizationId
  ) {
    return { ok: false, error: INTAKE_NOT_A_VERIFIED_VET };
  }

  const payload = validateEventPayload(INTAKE_EVENT_TYPE, {
    modality: visit.modality,
    general_condition: fields.generalCondition,
    presenting_complaint: fields.presentingComplaint,
    ...(fields.vitals ? { vitals: fields.vitals } : {}),
    findings: fields.findings,
  });
  const key = fields.clientIdempotencyKey;
  const now = new Date();
  const symptomText = [fields.presentingComplaint, fields.findings]
    .filter((t): t is string => Boolean(t))
    .join(". ");
  const symptomsMatch =
    symptomText.length > 0 && matchSymptoms(symptomText, pet.species).length > 0;
  const notifications: NewNotification[] = [];

  const writeInTx = async (tx: unknown) => {
    const executor = tx as Executor;

    const existing = await repo.findVisitEventOfType(visit.id, INTAKE_EVENT_TYPE, executor);
    if (existing) {
      if (key && existing.clientIdempotencyKey === key) {
        return { kind: "replay" as const, eventId: existing.id };
      }
      return { kind: "already_recorded" as const };
    }

    const common = {
      petId: pet.id,
      occurredAt,
      recordedAt: now,
      recordedByUserId: user.id,
      ...eventAuthorship,
      clientIdempotencyKey: key,
      visitId: visit.id,
    };

    const { event, wasNoop } = await repo.insertEventIdempotent(
      { ...common, eventType: INTAKE_EVENT_TYPE, payload } as Parameters<
        typeof repo.insertEventIdempotent
      >[0],
      executor,
    );
    if (wasNoop) return { kind: "replay" as const, eventId: event.id };

    let weightEventId: string | null = null;
    if (fields.weightKg) {
      const weight = await repo.insertEventIdempotent(
        {
          ...common,
          eventType: "weight_recorded",
          payload: validateEventPayload("weight_recorded", { kg: fields.weightKg }),
        } as Parameters<typeof repo.insertEventIdempotent>[0],
        executor,
      );
      weightEventId = weight.event.id;
      if (!weight.wasNoop) {
        await repo.updateWeightProjection(
          pet.id,
          now,
          tx as Parameters<typeof repo.updateWeightProjection>[2],
        );
      }
    }

    let symptomEventId: string | null = null;
    if (symptomsMatch) {
      const symptom = await createSymptomObservedWriter(
        {
          petId: pet.id,
          petPublicToken: pet.publicToken,
          petName: pet.name,
          petSpecies: pet.species,
          petJurisdictionCountry: pet.jurisdictionCountry,
          petJurisdictionProvince: pet.jurisdictionProvince,
          petJurisdictionLocality: pet.jurisdictionLocality,
          ...(pet.localityId !== undefined ? { petLocalityId: pet.localityId } : {}),
          ...(pet.placeMethod !== undefined ? { petPlaceMethod: pet.placeMethod } : {}),
          rabiesObservationStatus: pet.rabiesObservationStatus,
          recordedByUserId: user.id,
          eventAuthorship,
          freeText: symptomText,
          severity: null,
          onsetAt: null,
          clientIdempotencyKey: key,
          reporterRole: "vet",
          visitId: visit.id,
          now,
        },
        {
          repo,
          // The writer's transaction IS this one: the symptom commits or rolls
          // back with the intake.
          transaction: (cb) => cb(tx),
          flushNotifications: async (pending) => {
            notifications.push(...pending);
          },
        },
      );
      // A failed symptom write leaves this transaction aborted; rethrow so the
      // whole intake rolls back instead of committing half of it.
      if (!symptom.ok) throw new Error(symptom.error);
      symptomEventId = symptom.symptomEventId;
    }

    return { kind: "recorded" as const, eventId: event.id, weightEventId, symptomEventId };
  };

  // THE RACE THE PRE-READ CANNOT SEE. Two submits for one visit both read "no
  // intake yet" and both insert; the partial unique index lets one commit and
  // fails the other with a raw 23505. That loser gets the same answer the
  // pre-read would have given it — a replay when it carried the winner's key,
  // the refusal sentence otherwise — read after the winner committed.
  let outcome: Awaited<ReturnType<typeof writeInTx>>;
  try {
    outcome = await transaction(writeInTx);
  } catch (err) {
    if (!matchesDbError(err, { code: "23505", constraint: ONE_INTAKE_PER_VISIT_INDEX })) throw err;
    const winner = await repo.findVisitEventOfType(visit.id, INTAKE_EVENT_TYPE);
    outcome =
      winner && key && winner.clientIdempotencyKey === key
        ? { kind: "replay" as const, eventId: winner.id }
        : { kind: "already_recorded" as const };
  }

  if (outcome.kind === "already_recorded") return { ok: false, error: INTAKE_ALREADY_RECORDED };
  if (outcome.kind === "replay") {
    return {
      ok: true,
      value: {
        eventId: outcome.eventId,
        wasDuplicate: true,
        weightEventId: null,
        symptomEventId: null,
      },
      notifications: [],
    };
  }
  return {
    ok: true,
    value: {
      eventId: outcome.eventId,
      wasDuplicate: false,
      weightEventId: outcome.weightEventId,
      symptomEventId: outcome.symptomEventId,
    },
    notifications,
  };
}
