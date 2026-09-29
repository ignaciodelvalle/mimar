// recordConditionAtIntake against the real spine (vet-visit-record).
//
// The properties under test are about ROWS: two events in one transaction
// sharing one visit and one idempotency key, a replay that writes nothing, a
// second intake refused, a weight cache re-derived from the spine. A mock
// would hand back whatever rows the test wanted.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDbError } from "@/__tests__/_helpers/expect-db-error";
import {
  type VisitFixtures,
  insertVisit,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "@/__tests__/_helpers/visit-fixtures";
import { db, petEvents, pets } from "@/db";

import { EventsRepository } from "../../infrastructure/events-repository";
import type { ConditionAtIntakeFields } from "./condition-at-intake-form";
import {
  INTAKE_ALREADY_RECORDED,
  INTAKE_NOT_A_VERIFIED_VET,
  type RecordConditionAtIntakeInput,
  recordConditionAtIntake,
} from "./condition-at-intake-use-case";

const deps = {
  repo: new EventsRepository(),
  transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
};

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let org = "";
let otherOrg = "";
let seq = 0;

async function freshVisit(): Promise<{ petId: string; visitId: string }> {
  seq += 1;
  const petId = await makePet(fx, `I${seq}`);
  const visitId = await insertVisit({
    petId,
    organizationId: org,
    vetUserId: vet,
    modality: "home",
  });
  return { petId, visitId };
}

function fields(overrides: Partial<ConditionAtIntakeFields> = {}): ConditionAtIntakeFields {
  return {
    generalCondition: "fair",
    // Deliberately matches nothing in the symptom catalogue: the symptom
    // path has its own cases below.
    presentingComplaint: "Control anual",
    findings: "Sin particularidades",
    vitals: { temperature_c: 39.1, hydration: "mild" },
    weightKg: "14.20",
    clientIdempotencyKey: randomUUID(),
    ...overrides,
  };
}

function input(
  petId: string,
  visitId: string,
  overrides: Partial<RecordConditionAtIntakeInput> = {},
): RecordConditionAtIntakeInput {
  return {
    pet: {
      id: petId,
      publicToken: `VISIT-PET-${petId.slice(0, 8)}`,
      name: "Visita",
      species: "dog",
      jurisdictionCountry: "AR",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      rabiesObservationStatus: null,
    },
    user: { id: vet },
    eventAuthorship: { authorRole: "vet", authorOrganizationId: org, authorVerified: true },
    visit: { id: visitId, organizationId: org, modality: "home" },
    occurredAt: new Date("2026-09-20T13:00:00Z"),
    fields: fields(),
    ...overrides,
  };
}

async function rowsOf(petId: string) {
  return db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      visitId: petEvents.visitId,
      key: petEvents.clientIdempotencyKey,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.recordedByUserId, vet)));
}

beforeAll(async () => {
  vet = await makeProfile(fx, "vet");
  org = await makeOrg(fx, "A");
  otherOrg = await makeOrg(fx, "B");
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("recordConditionAtIntake — the write", () => {
  it("writes the intake and a sibling weight in ONE visit, sharing one key, and re-derives the weight cache", async () => {
    const { petId, visitId } = await freshVisit();
    const req = input(petId, visitId);
    const result = await recordConditionAtIntake(req, deps);
    expect(result).toMatchObject({ ok: true, value: { wasDuplicate: false } });

    const rows = await rowsOf(petId);
    expect(rows.map((r) => r.eventType).sort()).toEqual([
      "condition_at_intake_recorded",
      "weight_recorded",
    ]);
    for (const r of rows) {
      expect(r.visitId).toBe(visitId);
      expect(r.key).toBe(req.fields.clientIdempotencyKey);
    }
    const intake = rows.find((r) => r.eventType === "condition_at_intake_recorded");
    expect(intake?.payload).toEqual({
      payload_version: 1,
      modality: "home",
      general_condition: "fair",
      presenting_complaint: "Control anual",
      vitals: { temperature_c: 39.1, hydration: "mild" },
      findings: "Sin particularidades",
    });
    expect(intake?.payload).not.toHaveProperty("weight_kg");

    const [pet] = await db
      .select({ kg: pets.estimatedWeightKg })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(pet.kg).toBe("14.20");
  });

  it("writes no weight event when the animal was not weighed", async () => {
    const { petId, visitId } = await freshVisit();
    await recordConditionAtIntake(
      input(petId, visitId, { fields: fields({ weightKg: null }) }),
      deps,
    );
    expect((await rowsOf(petId)).map((r) => r.eventType)).toEqual(["condition_at_intake_recorded"]);
  });

  it("a replay with the same key writes nothing and reports the original", async () => {
    const { petId, visitId } = await freshVisit();
    const req = input(petId, visitId);
    const first = await recordConditionAtIntake(req, deps);
    const replay = await recordConditionAtIntake(req, deps);
    if (!first.ok || !replay.ok) throw new Error("expected both to succeed");
    expect(replay.value).toMatchObject({ eventId: first.value.eventId, wasDuplicate: true });
    expect(await rowsOf(petId)).toHaveLength(2);
  });

  it("a SECOND intake in the same visit is refused with a sentence", async () => {
    const { petId, visitId } = await freshVisit();
    await recordConditionAtIntake(input(petId, visitId), deps);
    const second = await recordConditionAtIntake(input(petId, visitId), deps);
    expect(second).toEqual({ ok: false, error: INTAKE_ALREADY_RECORDED });
    expect(
      (await rowsOf(petId)).filter((r) => r.eventType === "condition_at_intake_recorded"),
    ).toHaveLength(1);
  });

  it("the database refuses a second intake in one visit even past the read (unique index)", async () => {
    const { petId, visitId } = await freshVisit();
    await recordConditionAtIntake(input(petId, visitId), deps);
    await expectDbError(
      db.insert(petEvents).values({
        petId,
        eventType: "condition_at_intake_recorded",
        occurredAt: new Date("2026-09-20T13:00:00Z"),
        recordedByUserId: vet,
        authorRole: "vet",
        authorVerified: true,
        authorOrganizationId: org,
        payload: {
          modality: "home",
          general_condition: "good",
          presenting_complaint: null,
          findings: null,
        },
        visitId,
      }),
      { code: "23505", constraint: "pet_events_one_intake_per_visit" },
    );
  });
});

describe("recordConditionAtIntake — the race past the pre-read", () => {
  // A repository whose in-transaction pre-read sees nothing: exactly what the
  // loser of a race sees when the winner has not committed yet. Reads outside
  // a transaction (no executor) stay real.
  class StalePreReadRepository extends EventsRepository {
    override async findVisitEventOfType(
      visitId: string,
      eventType: string,
      executor?: Parameters<EventsRepository["findVisitEventOfType"]>[2],
    ) {
      if (executor) return null;
      return super.findVisitEventOfType(visitId, eventType);
    }
  }

  it("a loser with ANOTHER key gets the refusal sentence, not a raw 23505", async () => {
    const { petId, visitId } = await freshVisit();
    await recordConditionAtIntake(input(petId, visitId), deps);
    const loser = await recordConditionAtIntake(input(petId, visitId), {
      ...deps,
      repo: new StalePreReadRepository(),
    });
    expect(loser).toEqual({ ok: false, error: INTAKE_ALREADY_RECORDED });
    expect(
      (await rowsOf(petId)).filter((r) => r.eventType === "condition_at_intake_recorded"),
    ).toHaveLength(1);
  });

  it("two concurrent intakes for one visit: one records, the other is refused with a sentence", async () => {
    const { petId, visitId } = await freshVisit();
    const results = await Promise.all([
      recordConditionAtIntake(input(petId, visitId), deps),
      recordConditionAtIntake(input(petId, visitId), deps),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: INTAKE_ALREADY_RECORDED }]);
    expect(
      (await rowsOf(petId)).filter((r) => r.eventType === "condition_at_intake_recorded"),
    ).toHaveLength(1);
  });
});

describe("recordConditionAtIntake — who may write", () => {
  it.each([
    [
      "an unverified vet",
      { authorRole: "vet", authorOrganizationId: "ORG", authorVerified: false },
    ],
    [
      "an org member who is not a vet",
      { authorRole: "shelter", authorOrganizationId: "ORG", authorVerified: true },
    ],
    ["the owner", { authorRole: "owner", authorOrganizationId: null, authorVerified: false }],
    [
      "a vet of another organization",
      { authorRole: "vet", authorOrganizationId: "OTHER", authorVerified: true },
    ],
  ])("refuses %s and writes nothing", async (_label, authorship) => {
    const { petId, visitId } = await freshVisit();
    const eventAuthorship = {
      ...authorship,
      authorOrganizationId:
        authorship.authorOrganizationId === "ORG"
          ? org
          : authorship.authorOrganizationId === "OTHER"
            ? otherOrg
            : null,
    };
    const result = await recordConditionAtIntake(input(petId, visitId, { eventAuthorship }), deps);
    expect(result).toEqual({ ok: false, error: INTAKE_NOT_A_VERIFIED_VET });
    expect(await rowsOf(petId)).toEqual([]);
  });
});

describe("recordConditionAtIntake — the vet symptom path", () => {
  it("text that matches the catalogue emits symptom_observed as the VET, in the visit, with the shared key", async () => {
    const { petId, visitId } = await freshVisit();
    const req = input(petId, visitId, {
      fields: fields({ presentingComplaint: "Está decaído desde ayer", weightKg: null }),
    });
    const result = await recordConditionAtIntake(req, deps);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.symptomEventId).not.toBeNull();

    const symptom = (await rowsOf(petId)).find((r) => r.eventType === "symptom_observed");
    expect(symptom?.id).toBe(result.value.symptomEventId);
    expect(symptom?.visitId).toBe(visitId);
    expect(symptom?.key).toBe(req.fields.clientIdempotencyKey);
    expect(symptom?.payload).toMatchObject({
      reporter_role: "vet",
      source: "libreta",
      matched_symptom_codes: expect.arrayContaining(["lethargy"]),
    });
  });

  it("text that matches nothing emits no symptom_observed", async () => {
    const { petId, visitId } = await freshVisit();
    const result = await recordConditionAtIntake(input(petId, visitId), deps);
    expect(result).toMatchObject({ ok: true, value: { symptomEventId: null } });
    expect((await rowsOf(petId)).some((r) => r.eventType === "symptom_observed")).toBe(false);
  });

  it("a replay does not emit the symptom twice", async () => {
    const { petId, visitId } = await freshVisit();
    const req = input(petId, visitId, {
      fields: fields({ findings: "Apagado, sin energía", weightKg: null }),
    });
    await recordConditionAtIntake(req, deps);
    await recordConditionAtIntake(req, deps);
    expect((await rowsOf(petId)).filter((r) => r.eventType === "symptom_observed")).toHaveLength(1);
  });
});
