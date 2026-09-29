// DB integrity of visits and pet_events.visit_id (migration 0273).
//
// These rules live in Postgres, not in the application, so they are exercised
// against Postgres: the composite FK that makes a cross-pet link impossible,
// the BEFORE INSERT trigger that refuses a cross-organization link, and the
// BEFORE UPDATE trigger that gives a visit its lifecycle (closed once, modality
// frozen after the first event, identity columns immutable, nullable FKs only
// cleared). The open/reuse/expiry rules are application logic and are tested
// with src/modules/visits.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, visits } from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";
import {
  type VisitFixtures,
  insertVisit,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "./_helpers/visit-fixtures";

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let org = "";
let otherOrg = "";
let pet = "";
let otherPet = "";

function noteEvent(input: { petId: string; visitId: string | null; orgId: string | null }) {
  return db
    .insert(petEvents)
    .values({
      petId: input.petId,
      eventType: "note_added",
      occurredAt: new Date("2026-09-01T12:00:00Z"),
      recordedByUserId: vet,
      authorRole: "vet",
      authorOrganizationId: input.orgId,
      payload: { text: "visit constraint fixture" },
      visitId: input.visitId,
    })
    .returning({ id: petEvents.id, visitId: petEvents.visitId });
}

beforeAll(async () => {
  vet = await makeProfile(fx, "vet");
  org = await makeOrg(fx, "A");
  otherOrg = await makeOrg(fx, "B");
  pet = await makePet(fx, "A");
  otherPet = await makePet(fx, "B");
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("pet_events.visit_id — linking", () => {
  it("an event authored for the visit's org lands with visit_id stamped", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    const [row] = await noteEvent({ petId: pet, visitId, orgId: org });
    expect(row.visitId).toBe(visitId);
  });

  it("an event outside any visit keeps visit_id NULL", async () => {
    const [row] = await noteEvent({ petId: pet, visitId: null, orgId: null });
    expect(row.visitId).toBeNull();
  });

  it("refuses a visit of ANOTHER pet (composite FK)", async () => {
    const visitId = await insertVisit({ petId: otherPet, organizationId: org, vetUserId: vet });
    await expectDbError(noteEvent({ petId: pet, visitId, orgId: org }), {
      code: "23503",
      constraint: "pet_events_visit_fk",
    });
  });

  it("refuses a visit id that does not exist", async () => {
    await expectDbError(noteEvent({ petId: pet, visitId: randomUUID(), orgId: org }), {
      code: "23503",
      constraint: "pet_events_visit_fk",
    });
  });

  it("refuses an event authored for ANOTHER organization than the visit's (trigger)", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await expectDbError(noteEvent({ petId: pet, visitId, orgId: otherOrg }), {
      code: "23514",
      constraint: /belongs to organization/,
    });
    await expectDbError(noteEvent({ petId: pet, visitId, orgId: null }), {
      code: "23514",
      constraint: /belongs to organization/,
    });
  });
});

describe("visits — lifecycle trigger", () => {
  it("closes once: a second close with different values is refused, re-opening too", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await db
      .update(visits)
      .set({ closedAt: sql`now()`, closeReason: "vet", closedByUserId: vet })
      .where(eq(visits.id, visitId));

    await expectDbError(
      db.update(visits).set({ closeReason: "expired" }).where(eq(visits.id, visitId)),
      { code: "23514", constraint: /already closed/ },
    );
    await expectDbError(
      db.update(visits).set({ closedAt: null, closeReason: null }).where(eq(visits.id, visitId)),
      { code: "23514", constraint: /already closed/ },
    );
  });

  it("close_at and close_reason travel together (CHECK)", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await expectDbError(
      db.update(visits).set({ closedAt: sql`now()` }).where(eq(visits.id, visitId)),
      { code: "23514", constraint: "visits_close_pair" },
    );
  });

  it("modality changes while the visit is empty and freezes after its first event", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await db.update(visits).set({ modality: "home" }).where(eq(visits.id, visitId));
    const [changed] = await db
      .select({ modality: visits.modality })
      .from(visits)
      .where(eq(visits.id, visitId));
    expect(changed.modality).toBe("home");

    await noteEvent({ petId: pet, visitId, orgId: org });
    await expectDbError(
      db.update(visits).set({ modality: "clinic" }).where(eq(visits.id, visitId)),
      { code: "23514", constraint: /modality is frozen/ },
    );
  });

  it("identity columns are immutable", async () => {
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await expectDbError(
      db.update(visits).set({ organizationId: otherOrg }).where(eq(visits.id, visitId)),
      { code: "23514", constraint: /immutable/ },
    );
    await expectDbError(
      db
        .update(visits)
        .set({ openedAt: sql`now() - interval '1 day'` })
        .where(eq(visits.id, visitId)),
      { code: "23514", constraint: /immutable/ },
    );
  });

  it("the vet can be cleared (erasure) but never reassigned", async () => {
    const other = await makeProfile(fx, "otro-vet");
    const visitId = await insertVisit({ petId: pet, organizationId: org, vetUserId: vet });
    await expectDbError(db.update(visits).set({ vetUserId: other }).where(eq(visits.id, visitId)), {
      code: "23514",
      constraint: /never reassigned/,
    });
    await db.update(visits).set({ vetUserId: null }).where(eq(visits.id, visitId));
    const [row] = await db
      .select({ vetUserId: visits.vetUserId })
      .from(visits)
      .where(eq(visits.id, visitId));
    expect(row.vetUserId).toBeNull();
  });

  it("modality is limited to clinic | home (CHECK), on visits, offerings and appointments", async () => {
    await expectDbError(
      insertVisit({ petId: pet, organizationId: org, vetUserId: vet, modality: "remote" }),
      { code: "23514", constraint: "visits_modality_valid" },
    );
    const checks = (await db.execute(sql`
      SELECT conname FROM pg_constraint
       WHERE conname IN ('service_offerings_modality_valid', 'appointments_modality_valid')
       ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;
    expect(checks.map((c) => c.conname)).toEqual([
      "appointments_modality_valid",
      "service_offerings_modality_valid",
    ]);
  });
});
