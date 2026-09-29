// findVisitDrift against the real database (vet-visit-record, drift pass).
//
// Each case plants exactly the inconsistency it looks for, scoped to its own
// pet, and asserts the report names it — and names nothing on a clean visit.
// The organization mismatch is refused by trigger pet_events_visit_org_match,
// so the case that plants one does it with triggers off for one transaction
// (session_replication_role = replica), the way a pre-trigger row would exist.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
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
import { findVisitDrift, visitDriftCount } from "@/lib/infra/visit-drift";

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let org = "";
let otherOrg = "";

function intake(petId: string, visitId: string, modality: string, authorOrg: string) {
  return {
    petId,
    eventType: "condition_at_intake_recorded",
    occurredAt: new Date("2026-09-22T13:00:00Z"),
    recordedByUserId: vet,
    authorRole: "vet" as const,
    authorVerified: true,
    authorOrganizationId: authorOrg,
    payload: {
      payload_version: 1,
      modality,
      general_condition: "good",
      presenting_complaint: null,
      findings: null,
    },
    visitId,
  };
}

beforeAll(async () => {
  vet = await makeProfile(fx, "drift-vet");
  org = await makeOrg(fx, "DR1");
  otherOrg = await makeOrg(fx, "DR2");
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("findVisitDrift", () => {
  it("a clean visit reports nothing", async () => {
    const petId = await makePet(fx, "DC");
    const visitId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "home",
    });
    await db.insert(petEvents).values(intake(petId, visitId, "home", org));
    const report = await findVisitDrift(db, { petId });
    expect(report).toEqual({ modality: [], organization: [], emptyExpired: [] });
    expect(visitDriftCount(report)).toBe(0);
  });

  it("names an intake whose modality disagrees with its visit", async () => {
    const petId = await makePet(fx, "DM");
    const visitId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "clinic",
    });
    const [row] = await db
      .insert(petEvents)
      .values(intake(petId, visitId, "home", org))
      .returning({ id: petEvents.id });
    const report = await findVisitDrift(db, { petId });
    expect(report.modality).toEqual([
      { visitId, petId, eventId: row.id, visitModality: "clinic", recordedModality: "home" },
    ]);
    expect(visitDriftCount(report)).toBe(1);
  });

  it("names a stamped record authored for another organization (planted past the trigger)", async () => {
    const petId = await makePet(fx, "DO");
    const visitId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "home",
    });
    const eventId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .insert(petEvents)
        .values({ id: eventId, ...intake(petId, visitId, "home", otherOrg) });
    });
    const report = await findVisitDrift(db, { petId });
    expect(report.organization).toEqual([
      { visitId, petId, eventId, visitOrganizationId: org, eventOrganizationId: otherOrg },
    ]);
  });

  it("reads the modality AMENDED: a correction that matches the visit clears the drift", async () => {
    const petId = await makePet(fx, "DA");
    const visitId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "clinic",
    });
    const [row] = await db
      .insert(petEvents)
      .values(intake(petId, visitId, "home", org))
      .returning({ id: petEvents.id });
    await db.insert(petEvents).values({
      petId,
      eventType: "event_amended",
      occurredAt: new Date("2026-09-22T14:00:00Z"),
      recordedByUserId: vet,
      authorRole: "vet" as const,
      authorVerified: true,
      authorOrganizationId: org,
      payload: {
        target_event_id: row.id,
        reason: "Era en la clínica",
        changes: [{ field: "modality", old: "home", new: "clinic" }],
        actor_role: "vet",
      },
    });
    const report = await findVisitDrift(db, { petId });
    expect(report.modality).toEqual([]);
  });

  it("reports an empty expired visit as information, never as drift", async () => {
    const petId = await makePet(fx, "DE");
    const visitId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "clinic",
      closedAt: sql`now()` as unknown as Date,
      closeReason: "expired",
    });
    const report = await findVisitDrift(db, { petId });
    expect(report.emptyExpired).toEqual([{ visitId, petId }]);
    expect(visitDriftCount(report)).toBe(0);
  });
});
