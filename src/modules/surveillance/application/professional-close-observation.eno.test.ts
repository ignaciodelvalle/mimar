// Integration: a POSITIVE rabies close creates the ENO record (PO decision 1A).
//
// The defect this pins: closing an observation with `positive_rabies` wrote the
// `rabies_observation_ended` event and paged the authorities in-app, but left
// NOTHING in `event_notification_outbox` — the table /gob/outbox reads for its
// "Cola ENO" and legal SLA. A rabies `disease_diagnosis` lands there; a rabies
// case confirmed by observation, the same notifiable disease, did not. And the
// veterinarian's close screen already promised the authority would be notified.
//
// What is asserted, against the real database and the real repository:
//   - positive → exactly ONE outbox row, bound for the ENO preset, SLA = the
//     catalog's rabies window measured from the event itself, jurisdiction
//     snapshot of the pet, and the disease readable by the Cola ENO row.
//   - negative / dead → none.
//   - a second close → refused, still one row.
//   - a retried write of the same event (same idempotency key) → still one row.
//   - the row is atomic with the event: it is written inside the close's tx.
//
// No host clock is compared against a `defaultNow()` column: the SLA is checked
// against the ended event's `occurred_at`, which is the value the close wrote.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  enoProcessingQueue,
  eventNotificationOutbox,
  notifications,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { enqueueOutboxForEvent } from "@/lib/events/event-outbox-enqueue";
import { rabiesEnoCaseKey } from "@/lib/events/event-outbox-rules";
import { describeEnoNotification } from "@/lib/infra/outbox-list";
import { ENO_PRESET_TARGET_KINDS } from "@/lib/infra/outbox-query";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { recordDiseaseDiagnosisWriter } from "@/src/modules/events/application/writers";
import { withMutationOverride } from "../../../../__tests__/_helpers/db-overrides";
import { getEnoDisease } from "../domain/eno-catalog";
import type { RabiesObservationOutcome } from "../domain/rabies-observation";
import { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import { professionalCloseObservation } from "./professional-close-observation";

const GOVT_ID = "e40a0000-0000-4000-8000-00000000a001";
const VET_ID = "e40a0000-0000-4000-8000-00000000a002";
const PROFILE_IDS = [GOVT_ID, VET_ID];
const ORG_TOKEN = "ENO-RABIES-CLOSE-CLINIC";

const PROVINCE = "Buenos Aires";
const LOCALITY = "La Plata";

const repo = new SurveillanceRepository();
const createdPetIds: string[] = [];
let clinicOrgId: string;

async function cleanupFixtures() {
  const leftover = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.name} = 'EnoRabiesClosePet'`);
  const petIds = [...new Set([...createdPetIds, ...leftover.map((p) => p.id)])];
  if (petIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.relatedPetId, petIds));
    await db
      .delete(enoProcessingQueue)
      .where(
        inArray(
          enoProcessingQueue.petEventId,
          db.select({ id: petEvents.id }).from(petEvents).where(inArray(petEvents.petId, petIds)),
        ),
      );
    // Outbox rows cascade from pet_events (ON DELETE CASCADE).
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, petIds));
      await tx.delete(ownerships).where(inArray(ownerships.petId, petIds));
      await tx.delete(pets).where(inArray(pets.id, petIds));
    });
  }
  createdPetIds.length = 0;
  await db.delete(notifications).where(inArray(notifications.userId, PROFILE_IDS));
  await db.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  await db.delete(profiles).where(inArray(profiles.id, PROFILE_IDS));
}

beforeAll(async () => {
  await cleanupFixtures();
  await db.insert(profiles).values([
    { id: GOVT_ID, displayName: "eno-rabies-close-govt", role: "govt" },
    { id: VET_ID, displayName: "eno-rabies-close-vet", role: "vet" },
  ]);
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Clínica ENO Rabia SRL",
      displayName: "Clínica ENO Rabia",
      orgType: "clinic",
      email: "clinic@eno-rabies-close.test",
      verified: true,
    })
    .returning({ id: organizations.id });
  clinicOrgId = org.id;
});

afterAll(async () => {
  await cleanupFixtures();
});

/** A pet with an OPEN observation (in_progress + its started event). */
async function makeObservedPet(): Promise<{ id: string; publicToken: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "EnoRabiesClosePet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      rabiesObservationStatus: "in_progress",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning();
  createdPetIds.push(pet.id);

  const startedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await withMutationOverride(async (tx) => {
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "rabies_observation_started",
      occurredAt: startedAt,
      recordedAt: startedAt,
      recordedByUserId: GOVT_ID,
      authorRole: "govt",
      payload: {
        payload_version: 1,
        bite_event_id: crypto.randomUUID(),
        incident_severity: "low",
        observation_started_role: "govt",
        closure_target_role: "vet",
        observation_until: new Date(startedAt.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  });
  return { id: pet.id, publicToken: pet.publicToken };
}

const deps = {
  repo,
  closeCase: async () => {},
  transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
};

function closeAsGovt(publicToken: string, outcome: RabiesObservationOutcome) {
  return professionalCloseObservation(
    {
      petPublicToken: publicToken,
      outcome,
      closureNotes: "Notas clínicas que no deben salir en el aviso a la autoridad",
      actor: {
        profile: { id: GOVT_ID, role: "govt" },
        jurisdictions: [{ province: PROVINCE, locality: LOCALITY }],
      },
    },
    deps,
  );
}

async function outboxRowsFor(petId: string) {
  return db
    .select({
      sourceEventId: eventNotificationOutbox.sourceEventId,
      targetKind: eventNotificationOutbox.targetKind,
      province: eventNotificationOutbox.targetJurisdictionProvince,
      locality: eventNotificationOutbox.targetJurisdictionLocality,
      slaDueAt: eventNotificationOutbox.slaDueAt,
      status: eventNotificationOutbox.status,
      payloadSnapshot: eventNotificationOutbox.payloadSnapshot,
      eventOccurredAt: petEvents.occurredAt,
      eventType: petEvents.eventType,
    })
    .from(eventNotificationOutbox)
    .innerJoin(petEvents, eq(petEvents.id, eventNotificationOutbox.sourceEventId))
    .where(eq(petEvents.petId, petId));
}

describe("professionalCloseObservation → ENO outbox (PO 1A)", () => {
  it("positive_rabies (State path) → exactly one Cola ENO row with the rabies SLA", async () => {
    const pet = await makeObservedPet();
    const result = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await outboxRowsFor(pet.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.sourceEventId).toBe(result.value.endedEventId);
    expect(row.eventType).toBe("rabies_observation_ended");
    expect(ENO_PRESET_TARGET_KINDS).toContain(row.targetKind);
    expect(row.status).toBe("pending");
    expect(row.province).toBe(PROVINCE);
    expect(row.locality).toBe(LOCALITY);

    const legalHours = getEnoDisease("rabies")?.notifyHours ?? Number.NaN;
    expect(row.slaDueAt.getTime() - row.eventOccurredAt.getTime()).toBe(
      legalHours * 60 * 60 * 1000,
    );
    expect(describeEnoNotification(row.payloadSnapshot)).toEqual({
      diseaseLabel: "Rabia",
      legalHours,
    });
    expect(JSON.stringify(row.payloadSnapshot)).not.toContain("Notas clínicas");
  });

  it("positive_rabies (veterinary Atender path) → exactly one Cola ENO row", async () => {
    const pet = await makeObservedPet();
    const result = await professionalCloseObservation(
      {
        petPublicToken: pet.publicToken,
        outcome: "positive_rabies",
        closureNotes: null,
        actor: {
          profile: { id: VET_ID, role: "vet" },
          jurisdictions: [],
          organizationId: clinicOrgId,
          organizationName: "Clínica ENO Rabia",
        },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await outboxRowsFor(pet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceEventId).toBe(result.value.endedEventId);
    expect(describeEnoNotification(rows[0].payloadSnapshot)?.diseaseLabel).toBe("Rabia");
  });

  it.each(["negative", "dead"] as const)(
    "%s → no ENO record (not a notifiable case)",
    async (outcome) => {
      const pet = await makeObservedPet();
      const result = await closeAsGovt(pet.publicToken, outcome);
      expect(result.ok).toBe(true);
      expect(await outboxRowsFor(pet.id)).toHaveLength(0);
    },
  );

  it("a second close is refused and does not enqueue again", async () => {
    const pet = await makeObservedPet();
    const first = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(first.ok).toBe(true);
    const second = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(second.ok).toBe(false);
    expect(await outboxRowsFor(pet.id)).toHaveLength(1);
  });

  it("a retried write of the same ended event (same idempotency key) → still one row", async () => {
    const pet = await makeObservedPet();
    const values = {
      petId: pet.id,
      eventType: "rabies_observation_ended" as const,
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: GOVT_ID,
      authorRole: "govt" as const,
      clientIdempotencyKey: crypto.randomUUID(),
      payload: {
        bite_event_id: null,
        observation_started_event_id: crypto.randomUUID(),
        outcome: "positive_rabies",
        closed_by_role: "govt",
        closure_notes: null,
        death_event_id: null,
      },
    } as Parameters<typeof repo.insertObservationEnded>[0];

    const a = await db.transaction((tx) => repo.insertObservationEnded(values, tx));
    const b = await db.transaction((tx) => repo.insertObservationEnded(values, tx));
    expect(b.id).toBe(a.id);
    expect(await outboxRowsFor(pet.id)).toHaveLength(1);
  });

  it("the ENO row is atomic with the event: a rolled-back close leaves neither", async () => {
    const pet = await makeObservedPet();
    const values = {
      petId: pet.id,
      eventType: "rabies_observation_ended" as const,
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: GOVT_ID,
      authorRole: "govt" as const,
      payload: {
        bite_event_id: null,
        observation_started_event_id: crypto.randomUUID(),
        outcome: "positive_rabies",
        closed_by_role: "govt",
        closure_notes: null,
        death_event_id: null,
      },
    } as Parameters<typeof repo.insertObservationEnded>[0];

    await expect(
      db.transaction(async (tx) => {
        await repo.insertObservationEnded(values, tx);
        throw new Error("rollback on purpose");
      }),
    ).rejects.toThrow("rollback on purpose");

    const ended = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "rabies_observation_ended")));
    expect(ended).toHaveLength(0);
    expect(await outboxRowsFor(pet.id)).toHaveLength(0);
  });

  it("does not ALSO fan out through eno_processing_queue (the close already pages the authority)", async () => {
    const pet = await makeObservedPet();
    const result = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const queued = await db
      .select({ id: enoProcessingQueue.id })
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.petEventId, result.value.endedEventId));
    expect(queued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX-25 #3 (PO, 2026-09-25): ONE ENO RECORD PER CASE.
// "A Case may not be duplicated; all information related to a single event
// must be concentrated in a single record for consistency."
//
// Before: a rabies diagnosis wrote a Cola ENO row for itself AND for the
// outbreak_signal it derives, and the positive close of the same animal wrote
// a third. Now every rabies row carries the per-animal case key and the later
// writers link into the first (lib/events/event-outbox-enqueue.ts, unique
// index outbox_eno_case_unique from migration 0247). Real database throughout.
// ---------------------------------------------------------------------------

type LinkedSource = {
  source_event_id: string;
  event_type: string;
  previous_status: string;
  payload_snapshot: Record<string, unknown>;
};

async function enoRecordsFor(petId: string) {
  return db
    .select({
      id: eventNotificationOutbox.id,
      sourceEventId: eventNotificationOutbox.sourceEventId,
      enoCaseKey: eventNotificationOutbox.enoCaseKey,
      linkedSources: eventNotificationOutbox.linkedSources,
      status: eventNotificationOutbox.status,
      slaDueAt: eventNotificationOutbox.slaDueAt,
    })
    .from(eventNotificationOutbox)
    .where(eq(eventNotificationOutbox.enoCaseKey, rabiesEnoCaseKey(petId)));
}

async function diagnoseRabies(pet: { id: string }) {
  const result = await recordDiseaseDiagnosisWriter({
    petId: pet.id,
    petName: "EnoRabiesClosePet",
    petSpecies: "dog",
    petJurisdictionCountry: "AR",
    petJurisdictionProvince: PROVINCE,
    petJurisdictionLocality: LOCALITY,
    vetUserId: VET_ID,
    vetDisplayName: "Dra. Caso Unico",
    diseaseCode: "rabies_confirmed",
    confirmedByLab: true,
    labName: "INPPAZ",
    labReportReference: "LAB-CASO-UNICO",
    diagnosisDate: new Date(),
    notes: null,
  });
  if (!result.ok) throw new Error(`diagnosis failed: ${result.error}`);
  return result;
}

describe("one ENO record per rabies case (PO 2026-09-25)", () => {
  it("diagnosis then positive close → exactly ONE record, the close linked into it", async () => {
    const pet = await makeObservedPet();
    const diagnosis = await diagnoseRabies(pet);
    const close = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(close.ok).toBe(true);
    if (!close.ok) return;

    // Every Cola ENO row whose source is this animal's event: one.
    expect(await outboxRowsFor(pet.id)).toHaveLength(1);
    const records = await enoRecordsFor(pet.id);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.sourceEventId).toBe(diagnosis.diagnosisEventId);
    const linked = record.linkedSources as LinkedSource[];
    expect(linked.map((l) => l.source_event_id).sort()).toEqual(
      [diagnosis.signalEventId, close.value.endedEventId].sort(),
    );
    const closeLink = linked.find((l) => l.source_event_id === close.value.endedEventId);
    expect(closeLink?.event_type).toBe("rabies_observation_ended");
    expect(closeLink?.payload_snapshot.outcome).toBe("positive_rabies");
    // The close's clinical prose still never reaches the authority's record.
    expect(JSON.stringify(record.linkedSources)).not.toContain("Notas clínicas");
    expect(record.status).toBe("pending");
  });

  it("positive close then diagnosis → exactly ONE record, the diagnosis linked into it", async () => {
    const pet = await makeObservedPet();
    const close = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    const diagnosis = await diagnoseRabies(pet);

    expect(await outboxRowsFor(pet.id)).toHaveLength(1);
    const [record] = await enoRecordsFor(pet.id);
    expect(record.sourceEventId).toBe(close.value.endedEventId);
    expect((record.linkedSources as LinkedSource[]).map((l) => l.source_event_id).sort()).toEqual(
      [diagnosis.diagnosisEventId, diagnosis.signalEventId].sort(),
    );
  });

  it("replaying the enqueue for events already on the record changes nothing", async () => {
    const pet = await makeObservedPet();
    const diagnosis = await diagnoseRabies(pet);
    const close = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(close.ok).toBe(true);
    const [before] = await enoRecordsFor(pet.id);

    const events = await db
      .select({
        id: petEvents.id,
        petId: petEvents.petId,
        eventType: petEvents.eventType,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(eq(petEvents.petId, pet.id));
    // Twice over every event of the animal: the source and every link.
    for (let round = 0; round < 2; round++) {
      await db.transaction(async (tx) => {
        for (const e of events) {
          await enqueueOutboxForEvent(
            tx,
            { ...e, payload: e.payload as Record<string, unknown> },
            { jurisdictionProvince: PROVINCE, jurisdictionLocality: LOCALITY },
          );
        }
      });
    }

    const after = await enoRecordsFor(pet.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].linkedSources).toEqual(before.linkedSources);
    expect(after[0].slaDueAt.getTime()).toBe(before.slaDueAt.getTime());
    expect(await outboxRowsFor(pet.id)).toHaveLength(1);
    expect(after[0].sourceEventId).toBe(diagnosis.diagnosisEventId);
  });

  it("a record already DELIVERED is re-opened by the close, and the delivery is kept in the trail", async () => {
    const pet = await makeObservedPet();
    await diagnoseRabies(pet);
    const [first] = await enoRecordsFor(pet.id);
    await db
      .update(eventNotificationOutbox)
      .set({ status: "delivered", deliveredAt: new Date(), attempts: 1 })
      .where(eq(eventNotificationOutbox.id, first.id));

    const close = await closeAsGovt(pet.publicToken, "positive_rabies");
    expect(close.ok).toBe(true);
    if (!close.ok) return;

    const [record] = await enoRecordsFor(pet.id);
    expect(record.id).toBe(first.id);
    expect(record.status).toBe("pending");
    const closeLink = (record.linkedSources as LinkedSource[]).find(
      (l) => l.source_event_id === close.value.endedEventId,
    );
    expect(closeLink?.previous_status).toBe("delivered");
  });

  it("the database itself refuses a second row for the same case", async () => {
    const pet = await makeObservedPet();
    await diagnoseRabies(pet);
    const [record] = await enoRecordsFor(pet.id);
    await expect(
      db.insert(eventNotificationOutbox).values({
        sourceEventId: record.sourceEventId,
        targetKind: "govt_webhook",
        slaDueAt: new Date(),
        enoCaseKey: rabiesEnoCaseKey(pet.id),
      }),
    ).rejects.toThrow();
  });
});
