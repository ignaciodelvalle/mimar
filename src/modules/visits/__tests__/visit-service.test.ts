// The visits module's server entry points against the real spine
// (vet-visit-record, unit 5 — the Atender wiring).
//
// What the Atender page and writers rely on, end to end: the intake and a
// vaccine written by the same vet land in ONE visit; a replay writes nothing
// more; a closed visit is not reused; a visit is closed only through its own
// pet. Rows, not mocks — the stamping happens at insert.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type VisitFixtures,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "@/__tests__/_helpers/visit-fixtures";
import { db, petEvents } from "@/db";
import { recordConditionAtIntake } from "@/src/modules/events/application/clinical/condition-at-intake-use-case";
import { createVaccination } from "@/src/modules/events/application/medical/vaccination-use-case";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import {
  closeVisitOfPet,
  findCurrentOpenVisit,
  openVisit,
  visitScopedEventsRepository,
} from "../infrastructure/visit-service";

const transaction = db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let org = "";
let seq = 0;

function authorship() {
  return { authorRole: "vet", authorOrganizationId: org, authorVerified: true };
}

async function freshKey() {
  seq += 1;
  const petId = await makePet(fx, `S${seq}`);
  return { petId, organizationId: org, vetUserId: vet };
}

async function rowsOf(petId: string) {
  return db
    .select({ eventType: petEvents.eventType, visitId: petEvents.visitId })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.recordedByUserId, vet)));
}

async function intake(key: { petId: string }, visit: { id: string }, clientKey: string) {
  return recordConditionAtIntake(
    {
      pet: {
        id: key.petId,
        publicToken: `VISIT-SVC-${key.petId.slice(0, 8)}`,
        name: "Servicio",
        species: "dog",
        jurisdictionCountry: "AR",
        jurisdictionProvince: null,
        jurisdictionLocality: null,
        rabiesObservationStatus: null,
      },
      user: { id: vet },
      eventAuthorship: authorship(),
      visit: { id: visit.id, organizationId: org, modality: "clinic" },
      occurredAt: new Date("2026-09-21T13:00:00Z"),
      fields: {
        generalCondition: "good",
        presentingComplaint: "Control",
        findings: null,
        vitals: null,
        weightKg: "8.00",
        clientIdempotencyKey: clientKey,
      },
    },
    { repo: new EventsRepository(), transaction },
  );
}

async function vaccinate(petId: string, repo: EventsRepository) {
  return createVaccination(
    {
      pet: { id: petId },
      user: { id: vet },
      eventAuthorship: authorship(),
      vaccineName: "Antirrábica",
      occurredAt: new Date("2026-09-21T13:10:00Z"),
      brand: null,
      batch: null,
      administeredBy: null,
      nextDueAt: null,
      notes: null,
      sourceReminderId: null,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: randomUUID(),
    },
    { repo, transaction },
  );
}

beforeAll(async () => {
  vet = await makeProfile(fx, "svc-vet");
  org = await makeOrg(fx, "SVC");
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("visit service — one atención, one visit", () => {
  it("the intake and a later vaccine by the same vet share ONE visit_id", async () => {
    const key = await freshKey();
    const opened = await openVisit(key);
    if (!opened.ok) throw new Error("expected the visit to open");
    const result = await intake(key, opened.visit, randomUUID());
    expect(result.ok).toBe(true);

    const vaccine = await vaccinate(key.petId, await visitScopedEventsRepository(key));
    expect(vaccine.ok).toBe(true);

    const rows = await rowsOf(key.petId);
    expect(rows.map((r) => r.eventType).sort()).toEqual([
      "condition_at_intake_recorded",
      "vaccination_administered",
      "weight_recorded",
    ]);
    expect(new Set(rows.map((r) => r.visitId))).toEqual(new Set([opened.visit.id]));
  });

  it("a replayed intake writes nothing more into the visit", async () => {
    const key = await freshKey();
    const opened = await openVisit(key);
    if (!opened.ok) throw new Error("expected the visit to open");
    const clientKey = randomUUID();
    await intake(key, opened.visit, clientKey);
    const replay = await intake(key, opened.visit, clientKey);
    expect(replay).toMatchObject({ ok: true, value: { wasDuplicate: true } });
    expect(await rowsOf(key.petId)).toHaveLength(2);
  });

  it("a vaccine with no visit open opens one implicitly (care is never refused)", async () => {
    const key = await freshKey();
    expect(await findCurrentOpenVisit(key)).toBeNull();
    await vaccinate(key.petId, await visitScopedEventsRepository(key));
    const current = await findCurrentOpenVisit(key);
    expect(current).toMatchObject({ modality: "clinic" });
    const [row] = await rowsOf(key.petId);
    expect(row.visitId).toBe(current?.id);
  });
});

describe("visit service — closing", () => {
  it("a visit closes only through its own pet; afterwards the next write opens a new one", async () => {
    const key = await freshKey();
    const other = await freshKey();
    const opened = await openVisit(key);
    if (!opened.ok) throw new Error("expected the visit to open");

    const foreign = await closeVisitOfPet({
      visitId: opened.visit.id,
      petId: other.petId,
      organizationId: org,
      actorUserId: vet,
    });
    expect(foreign).toEqual({ ok: false, reason: "not_found" });
    expect((await findCurrentOpenVisit(key))?.id).toBe(opened.visit.id);

    const closed = await closeVisitOfPet({
      visitId: opened.visit.id,
      petId: key.petId,
      organizationId: org,
      actorUserId: vet,
    });
    expect(closed).toMatchObject({ ok: true, alreadyClosed: false });
    expect(await findCurrentOpenVisit(key)).toBeNull();

    await vaccinate(key.petId, await visitScopedEventsRepository(key));
    const [row] = await rowsOf(key.petId);
    expect(row.visitId).not.toBeNull();
    expect(row.visitId).not.toBe(opened.visit.id);
  });
});
