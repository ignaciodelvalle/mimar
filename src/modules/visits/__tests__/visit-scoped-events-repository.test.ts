// VisitScopedEventsRepository against the real spine (migration 0273).
//
// The stamp has to land AT INSERT — pet_events is append-only, there is no
// later UPDATE that could add it — so the only honest test is to insert
// through the repository and read the row back.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type VisitFixtures,
  insertVisit,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "@/__tests__/_helpers/visit-fixtures";
import { db, petEvents } from "@/db";
import type { NewPetEvent } from "@/db/schema";

import {
  VisitScopedEventsRepository,
  stampVisit,
} from "../infrastructure/visit-scoped-events-repository";

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let otherVet = "";
let org = "";
let otherOrg = "";
let petId = "";
let visitId = "";
let repo: VisitScopedEventsRepository;

function weight(overrides: Partial<NewPetEvent> = {}): NewPetEvent {
  return {
    petId,
    eventType: "weight_recorded",
    occurredAt: new Date("2026-09-01T12:00:00Z"),
    recordedByUserId: vet,
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: org,
    payload: { kg: "8.50" },
    ...overrides,
  };
}

async function visitIdOf(eventId: string): Promise<string | null> {
  const [row] = await db
    .select({ visitId: petEvents.visitId })
    .from(petEvents)
    .where(eq(petEvents.id, eventId));
  return row.visitId;
}

beforeAll(async () => {
  vet = await makeProfile(fx, "vet");
  otherVet = await makeProfile(fx, "otro-vet");
  org = await makeOrg(fx, "A");
  otherOrg = await makeOrg(fx, "B");
  petId = await makePet(fx, "STAMP");
  visitId = await insertVisit({ petId, organizationId: org, vetUserId: vet });
  repo = new VisitScopedEventsRepository({ id: visitId, organizationId: org, vetUserId: vet });
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("VisitScopedEventsRepository — insertEvent", () => {
  it("stamps the visit's vet's act for the visit's organization", async () => {
    const event = await repo.insertEvent(weight());
    expect(event.visitId).toBe(visitId);
    expect(await visitIdOf(event.id)).toBe(visitId);
  });

  it("leaves a system row (no recorder, no org) unstamped", async () => {
    const event = await repo.insertEvent(
      weight({ recordedByUserId: null, authorOrganizationId: null, authorRole: "owner" }),
    );
    expect(await visitIdOf(event.id)).toBeNull();
  });

  it("leaves another vet's row unstamped", async () => {
    const event = await repo.insertEvent(weight({ recordedByUserId: otherVet }));
    expect(await visitIdOf(event.id)).toBeNull();
  });

  it("leaves a row authored for another organization unstamped (and the DB would refuse it stamped)", async () => {
    const event = await repo.insertEvent(weight({ authorOrganizationId: otherOrg }));
    expect(await visitIdOf(event.id)).toBeNull();
  });
});

describe("VisitScopedEventsRepository — insertEventIdempotent", () => {
  it("stamps on first write and a replay with the same key returns the stamped original", async () => {
    const key = randomUUID();
    const first = await repo.insertEventIdempotent(weight({ clientIdempotencyKey: key }));
    const replay = await repo.insertEventIdempotent(weight({ clientIdempotencyKey: key }));
    expect(first.wasNoop).toBe(false);
    expect(first.event.visitId).toBe(visitId);
    expect(replay.wasNoop).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.event.visitId).toBe(visitId);
  });
});

describe("stampVisit — pure", () => {
  it("never overrides an explicit visitId", () => {
    const explicit = randomUUID();
    const values = stampVisit(
      { ...weight(), visitId: explicit },
      { id: visitId, organizationId: org, vetUserId: vet },
    );
    expect(values.visitId).toBe(explicit);
  });

  it("stamps nothing for a visit whose vet was erased", () => {
    const values = stampVisit(weight(), { id: visitId, organizationId: org, vetUserId: null });
    expect(values.visitId).toBeUndefined();
  });
});
