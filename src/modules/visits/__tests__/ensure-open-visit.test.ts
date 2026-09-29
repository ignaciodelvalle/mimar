// ensureOpenVisit / closeVisit against the real database (migration 0273).
//
// The resolution rules — reuse, the 12h stale window, supersede, the caller's
// id — are decisions taken under an advisory lock and judged by the DATABASE
// clock, so a fake repository would test the fake. Every case gets its own
// pet (the lock key and the open-visit lookup are per pet), so the cases do
// not see each other's visits.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
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
import { db, petEvents, visits } from "@/db";

import { closeVisit } from "../application/close-visit";
import { ensureOpenVisit } from "../application/ensure-open-visit";
import { VisitsRepository } from "../infrastructure/visits-repository";

const repo = new VisitsRepository();
const transaction = db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
const deps = { repo, transaction };

const fx: VisitFixtures = newVisitFixtures();
let vet = "";
let otherVet = "";
let org = "";
let otherOrg = "";
let petSeq = 0;

async function freshPet(): Promise<string> {
  petSeq += 1;
  return makePet(fx, `E${petSeq}`);
}

async function readVisit(id: string) {
  const [row] = await db.select().from(visits).where(eq(visits.id, id));
  return row;
}

async function openVisitsFor(petId: string) {
  return db
    .select({ id: visits.id })
    .from(visits)
    .where(sql`${visits.petId} = ${petId} AND ${visits.closedAt} IS NULL`);
}

async function weightEvent(petId: string, visitId: string | null) {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "weight_recorded",
      occurredAt: new Date("2026-09-01T12:00:00Z"),
      recordedByUserId: vet,
      authorRole: "vet",
      authorOrganizationId: org,
      payload: { kg: "10.00" },
      visitId,
    })
    .returning({ id: petEvents.id, recordedAt: petEvents.recordedAt });
  return row;
}

beforeAll(async () => {
  vet = await makeProfile(fx, "vet");
  otherVet = await makeProfile(fx, "otro-vet");
  org = await makeOrg(fx, "A");
  otherOrg = await makeOrg(fx, "B");
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("ensureOpenVisit — open and reuse", () => {
  it("opens a clinic visit when none is open, then reuses it", async () => {
    const petId = await freshPet();
    const first = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    expect(first.ok && first.created).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.visit).toMatchObject({
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "clinic",
    });

    const second = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    expect(second).toMatchObject({ ok: true, created: false, visit: { id: first.visit.id } });
    expect(await openVisitsFor(petId)).toHaveLength(1);
  });

  it("does not reuse another vet's or another organization's open visit", async () => {
    const petId = await freshPet();
    const mine = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    const otherVets = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: otherVet,
    });
    const otherOrgs = await ensureOpenVisit(deps, {
      petId,
      organizationId: otherOrg,
      vetUserId: vet,
    });
    if (!mine.ok || !otherVets.ok || !otherOrgs.ok) throw new Error("expected three opens");
    expect(new Set([mine.visit.id, otherVets.visit.id, otherOrgs.visit.id]).size).toBe(3);
  });

  it("two concurrent opens for the same (pet, org, vet) produce ONE visit", async () => {
    const petId = await freshPet();
    const results = await Promise.all([
      ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet }),
      ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet }),
      ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet }),
    ]);
    const ids = new Set(results.map((r) => (r.ok ? r.visit.id : "refused")));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await openVisitsFor(petId)).toHaveLength(1);
  });

  it("an explicit modality on an EMPTY open visit updates it; after an event it does not", async () => {
    const petId = await freshPet();
    const opened = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    if (!opened.ok) throw new Error("expected an open");

    const home = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "home",
    });
    expect(home).toMatchObject({
      ok: true,
      created: false,
      visit: { id: opened.visit.id, modality: "home" },
    });

    await weightEvent(petId, opened.visit.id);
    const clinic = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      modality: "clinic",
    });
    expect(clinic).toMatchObject({ ok: true, visit: { id: opened.visit.id, modality: "home" } });
    expect((await readVisit(opened.visit.id)).modality).toBe("home");
  });

  it("refuses an appointment that is not this pet's at this organization", async () => {
    const petId = await freshPet();
    const result = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      appointmentId: randomUUID(),
    });
    expect(result).toEqual({ ok: false, reason: "foreign_appointment" });
    expect(await openVisitsFor(petId)).toHaveLength(0);
  });
});

describe("ensureOpenVisit — stale and superseded", () => {
  it("expires an open visit older than 12h at its last event, and opens a new one", async () => {
    const petId = await freshPet();
    const staleId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      openedAt: sql`now() - interval '13 hours'` as unknown as Date,
    });
    const event = await weightEvent(petId, staleId);

    const result = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    expect(result.ok && result.created).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.visit.id).not.toBe(staleId);

    const stale = await readVisit(staleId);
    expect(stale.closeReason).toBe("expired");
    expect(stale.closedAt?.getTime()).toBe(event.recordedAt.getTime());
  });

  it("expires an EMPTY stale visit at its own opening time", async () => {
    const petId = await freshPet();
    const staleId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      openedAt: sql`now() - interval '2 days'` as unknown as Date,
    });
    await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    const stale = await readVisit(staleId);
    expect(stale.closeReason).toBe("expired");
    expect(stale.closedAt?.getTime()).toBe(stale.openedAt.getTime());
  });

  it("keeps the newest of two fresh open visits and supersedes the older", async () => {
    const petId = await freshPet();
    const olderId = await insertVisit({
      petId,
      organizationId: org,
      vetUserId: vet,
      openedAt: sql`now() - interval '1 hour'` as unknown as Date,
    });
    const newerId = await insertVisit({ petId, organizationId: org, vetUserId: vet });

    const result = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    expect(result).toMatchObject({ ok: true, created: false, visit: { id: newerId } });
    expect((await readVisit(olderId)).closeReason).toBe("superseded");
    expect((await readVisit(newerId)).closedAt).toBeNull();
  });
});

describe("ensureOpenVisit — caller-supplied id", () => {
  it("is idempotent: the same id twice is one visit, created once", async () => {
    const petId = await freshPet();
    const id = randomUUID();
    const first = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      visitId: id,
    });
    const replay = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      visitId: id,
    });
    expect(first).toMatchObject({ ok: true, created: true, visit: { id } });
    expect(replay).toMatchObject({ ok: true, created: false, visit: { id } });
    expect(await openVisitsFor(petId)).toHaveLength(1);
  });

  it("supersedes an older open visit when a new caller id arrives", async () => {
    const petId = await freshPet();
    const webVisit = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    if (!webVisit.ok) throw new Error("expected an open");
    const id = randomUUID();
    const synced = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      visitId: id,
    });
    expect(synced).toMatchObject({ ok: true, created: true, visit: { id } });
    expect((await readVisit(webVisit.visit.id)).closeReason).toBe("superseded");
  });

  it("refuses an id that belongs to another vet's visit, and leaves it untouched", async () => {
    const petId = await freshPet();
    const foreignId = await insertVisit({ petId, organizationId: org, vetUserId: otherVet });
    const result = await ensureOpenVisit(deps, {
      petId,
      organizationId: org,
      vetUserId: vet,
      visitId: foreignId,
    });
    expect(result).toEqual({ ok: false, reason: "foreign_visit" });
    const foreign = await readVisit(foreignId);
    expect(foreign.vetUserId).toBe(otherVet);
    expect(foreign.closedAt).toBeNull();
  });
});

describe("closeVisit", () => {
  it("closes once at the database clock; a second close is a no-op that reports the first", async () => {
    const petId = await freshPet();
    const opened = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    if (!opened.ok) throw new Error("expected an open");
    await weightEvent(petId, opened.visit.id);

    const first = await closeVisit(deps, {
      visitId: opened.visit.id,
      organizationId: org,
      actorUserId: vet,
    });
    expect(first).toMatchObject({ ok: true, alreadyClosed: false, visit: { closeReason: "vet" } });
    const again = await closeVisit(deps, {
      visitId: opened.visit.id,
      organizationId: org,
      actorUserId: vet,
    });
    expect(again).toMatchObject({ ok: true, alreadyClosed: true });
    if (!first.ok || !again.ok) throw new Error("unreachable");
    expect(again.visit.closedAt?.getTime()).toBe(first.visit.closedAt?.getTime());

    // The event grouped under the visit is untouched (append-only spine).
    const events = await db
      .select({ visitId: petEvents.visitId })
      .from(petEvents)
      .where(eq(petEvents.visitId, opened.visit.id));
    expect(events).toHaveLength(1);
  });

  it("a visit of another organization is not_found and stays open", async () => {
    const petId = await freshPet();
    const opened = await ensureOpenVisit(deps, { petId, organizationId: org, vetUserId: vet });
    if (!opened.ok) throw new Error("expected an open");
    const result = await closeVisit(deps, {
      visitId: opened.visit.id,
      organizationId: otherOrg,
      actorUserId: vet,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect((await readVisit(opened.visit.id)).closedAt).toBeNull();
  });
});
