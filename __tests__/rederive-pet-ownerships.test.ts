// Drift detection for the caretaker half of the `ownerships` cache.
//
// WHY A SIBLING HARNESS AND NOT AN EXTENSION OF rederivePetCache
// ---------------------------------------------------------------------------
// `rederivePetCache` returns `Record<column, {stored, derived}>` over ONE `pets`
// row, and both of its consumers (the fitness test and
// scripts/detect-pet-cache-drift.ts) are written against that shape. A
// caretaker arrangement is not a column: it is a SET OF ROWS WITH A LIFECYCLE.
// Forcing it in would distort a working abstraction and both consumers, so this
// is a sibling with its own shape — design decision F.
//
// WHAT THE PROPOSAL GOT WRONG, and why this file exists at all: the success
// criterion "drift detection is clean" would have passed VACUOUSLY.
// `ownerships` is covered by no drift detector whatsoever — not for caretaker,
// and not for owner / foster / shelter_custody either. The harness had nothing
// to say about ownership rows, so it could only ever have said "clean".
//
// SCOPED TO caretaker. Replaying the other three roles means modelling
// custody_transferred, adoption_finalized, decomiso, free-claim and chip-match.
// That is a different change. The general gap is logged as a finding
// (T8.7) rather than half-fixed here.
//
// Three layers, the shape the pet-cache harness established:
//   1. round-trip — drive the REAL writers, assert clean.
//   2. non-vacuity — skew the cache by raw SQL, assert the harness SEES it.
//      Without this a harness that always returns "clean" passes layer 1.
//   3. the asymmetric failures — a row with no event, an event with no row.

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petCaretakerGrants, petEvents, pets, profiles } from "@/db";
import {
  explainPetOwnerOwnerships,
  hasOwnershipDrift,
  rederivePetCaretakerOwnerships,
  unexplainedOwnerRows,
} from "@/lib/infra/rederive-pet-ownerships";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";

import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-DRFT-0001";
const TITULAR_ID = "0cae7a15-5555-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a15-5555-4000-8000-000000000002";

const NOW = new Date("2026-08-21T10:00:00.000Z");
const ENDS_AT = new Date("2026-09-15T00:00:00.000Z");

let petId: string;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM pet_caretaker_grants WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
    );
  });
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid)`,
  );
}

/** Runs a full designate → accept through the REAL writers. */
async function acceptOne(): Promise<{ grantId: string; ownershipId: string }> {
  const grant = await CaretakersRepository.insertGrant({
    petId,
    grantedByUserId: TITULAR_ID,
    caretakerUserId: CARETAKER_ID,
    caretakerEmail: "ana@example.com",
    startsAt: NOW,
    endsAt: ENDS_AT,
    note: null,
    now: NOW,
  });
  const { ownershipId } = await db.transaction((tx) =>
    CaretakersRepository.insertAcceptGrant(
      {
        grantId: grant.id,
        petId,
        caretakerUserId: CARETAKER_ID,
        grantPublicToken: grant.publicToken,
        endsAt: ENDS_AT,
        note: null,
        publicContactConsent: false,
        now: NOW,
      },
      tx,
    ),
  );
  return { grantId: grant.id, ownershipId };
}

async function endOne(grantId: string, ownershipId: string): Promise<void> {
  await db.transaction((tx) =>
    CaretakersRepository.insertEndGrant(
      {
        grantId,
        petId,
        ownershipId,
        outcome: "expired",
        endsAt: ENDS_AT,
        actorUserId: null,
        now: new Date("2026-09-16T04:00:00.000Z"),
      },
      tx,
    ),
  );
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular Drift", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora Drift", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa Drift", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: TITULAR_ID, role: "owner" });
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM pet_caretaker_grants WHERE pet_id = ${petId}::uuid`);
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
  });
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id = ${petId}::uuid AND role = 'caretaker'`,
  );
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// Layer 1 — round-trip against the real writers
// ---------------------------------------------------------------------------

describe("rederivePetCaretakerOwnerships — clean after the real writers", () => {
  it("reports no drift for a pet that never had a caretaker", async () => {
    const report = await rederivePetCaretakerOwnerships(petId);

    expect(report.derived).toEqual([]);
    expect(report.stored).toEqual([]);
    expect(hasOwnershipDrift(report)).toBe(false);
  });

  it("reports no drift after a designate → accept", async () => {
    await acceptOne();

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(report.derived).toHaveLength(1);
    expect(report.stored).toHaveLength(1);
    expect(hasOwnershipDrift(report)).toBe(false);
    expect(report.mismatches).toEqual([]);
  });

  it("reports no drift after a full designate → accept → expire cycle", async () => {
    const { grantId, ownershipId } = await acceptOne();
    await endOne(grantId, ownershipId);

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(hasOwnershipDrift(report)).toBe(false);
    expect(report.derived[0].endedAt).not.toBeNull();
    expect(report.stored[0].endedAt).not.toBeNull();
  });

  it("reports no drift across two sequential arrangements", async () => {
    const first = await acceptOne();
    await endOne(first.grantId, first.ownershipId);
    const second = await acceptOne();

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(report.derived).toHaveLength(2);
    expect(hasOwnershipDrift(report)).toBe(false);
    expect(second.ownershipId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — non-vacuity. A harness that always says "clean" passes layer 1.
// ---------------------------------------------------------------------------

describe("rederivePetCaretakerOwnerships — the harness actually detects skew", () => {
  it("DETECTS an ownership row closed with no matching caretaker_ended", async () => {
    // The asymmetric failure that matters most: the caretaker silently loses
    // access and nothing in the append-only log says why. No later event can
    // repair it, because corrections are new events rather than edits.
    const { ownershipId } = await acceptOne();
    await db
      .update(ownerships)
      .set({ endedAt: new Date("2026-09-01T00:00:00Z") })
      .where(eq(ownerships.id, ownershipId));

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(hasOwnershipDrift(report)).toBe(true);
    expect(report.mismatches.join(" ")).toMatch(/ended_at/i);
  });

  it("DETECTS an event with no ownership row at all", async () => {
    // The other direction: the spine says an arrangement started and the
    // caretaker has no access. The log is right and the world is wrong.
    //
    // Getting into this state took TWO steps, and that is itself a finding: a
    // plain `DELETE FROM ownerships` is REFUSED (23514) while an accepted grant
    // still points at the row — the ON DELETE SET NULL would violate 0192's
    // accept CHECK. So the database already makes the most obvious route into
    // this drift unreachable, and the harness is here for the routes it does
    // not close (a raw UPDATE, a restore from a partial dump, a future writer).
    await acceptOne();
    await expect(
      db
        .delete(ownerships)
        .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "caretaker"))),
    ).rejects.toThrow();
    await db.execute(sql`DELETE FROM pet_caretaker_grants WHERE pet_id = ${petId}::uuid`);
    await db
      .delete(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "caretaker")));

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(hasOwnershipDrift(report)).toBe(true);
    expect(report.mismatches.join(" ")).toMatch(/no ownership row/i);
  });

  it("DETECTS an ownership row with no event behind it", async () => {
    // A seed, a script or a future feature writing the cache half directly. The
    // row grants real write access, so an unexplained one is a security fact,
    // not a bookkeeping one.
    await db.insert(ownerships).values({
      petId,
      ownerUserId: CARETAKER_ID,
      role: "caretaker",
      startedAt: NOW,
    });

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(hasOwnershipDrift(report)).toBe(true);
    expect(report.mismatches.join(" ")).toMatch(/no caretaker_designated/i);
  });

  it("DETECTS a row whose caretaker is not the person the event names", async () => {
    await acceptOne();
    await db
      .update(ownerships)
      .set({ ownerUserId: TITULAR_ID })
      .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "caretaker")));

    const report = await rederivePetCaretakerOwnerships(petId);

    expect(hasOwnershipDrift(report)).toBe(true);
  });

  it("does NOT flag the titular's own owner row", async () => {
    // Scoped to caretaker. The `owner` row on this fixture has no event replay
    // behind it either, and reporting it would make every pet in the corpus
    // drift — which is the general gap, deliberately out of scope here.
    const report = await rederivePetCaretakerOwnerships(petId);

    expect(report.stored.every((r) => r.role === "caretaker")).toBe(true);
    expect(hasOwnershipDrift(report)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The corpus, so the harness is not only exercised on its own fixture
// ---------------------------------------------------------------------------

describe("caretaker ownership drift — whole corpus", () => {
  it("no pet in the database has caretaker drift", async () => {
    const withCaretakerActivity = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.role, "caretaker"))
      .groupBy(ownerships.petId);

    const eventPets = await db
      .select({ petId: petEvents.petId })
      .from(petEvents)
      .where(sql`${petEvents.eventType} IN ('caretaker_designated','caretaker_ended')`)
      .groupBy(petEvents.petId);

    const ids = [...new Set([...withCaretakerActivity, ...eventPets].map((r) => r.petId))];

    const drifted: string[] = [];
    for (const id of ids) {
      const report = await rederivePetCaretakerOwnerships(id);
      if (hasOwnershipDrift(report)) drifted.push(`${id}: ${report.mismatches.join("; ")}`);
    }

    expect(drifted, drifted.join("\n")).toEqual([]);
  });

  it("leaves no orphan caretaker rows behind after this file runs", async () => {
    // Guard on the fixture itself: a leaked active caretaker row would trip the
    // partial unique index for every later test file on this pet.
    const active = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "caretaker"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(active).toEqual([]);
    // Referenced so the import stays honest about what this file touches.
    expect(petCaretakerGrants).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// OWNER rows — the necessary condition (finding A09-5)
// ---------------------------------------------------------------------------
//
// Not a replay: the check asks only whether the owner row's subject is named by
// ANY event on the pet's spine. The fixture's titular row is inserted by raw SQL
// with no event, so it is exactly the "titularidad nothing explains" case until
// an event names the titular. afterEach wipes this pet's events between cases.

describe("owner ownership — every owner row is named on the spine", () => {
  it("flags an owner row that no event names (non-vacuity)", async () => {
    const report = await explainPetOwnerOwnerships(petId);

    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toContain(TITULAR_ID);
    expect(report.mismatches[0]).toContain("active owner row");
  });

  it("is still unexplained when the only event names somebody else", async () => {
    await db.insert(petEvents).values({
      petId,
      eventType: "note_added",
      occurredAt: NOW,
      recordedByUserId: CARETAKER_ID,
      payload: { text: "nota de otra persona" },
    });

    const report = await explainPetOwnerOwnerships(petId);
    expect(report.mismatches).toHaveLength(1);
  });

  it("is explained by an event the titular authored", async () => {
    await db.insert(petEvents).values({
      petId,
      eventType: "pet_registered",
      occurredAt: NOW,
      recordedByUserId: TITULAR_ID,
      payload: {},
    });

    expect((await explainPetOwnerOwnerships(petId)).mismatches).toEqual([]);
  });

  it("is explained by a payload that names the titular (transfer / adoption shape)", async () => {
    await db.insert(petEvents).values({
      petId,
      eventType: "custody_transferred",
      occurredAt: NOW,
      recordedByUserId: CARETAKER_ID,
      payload: { from_role: "owner", to_role: "owner", to_user_id: TITULAR_ID },
    });

    expect((await explainPetOwnerOwnerships(petId)).mismatches).toEqual([]);
  });
});

describe("unexplainedOwnerRows — pure", () => {
  const ORG = "0cae7a15-5555-4000-8000-0000000000aa";
  const row = (over: Partial<Parameters<typeof unexplainedOwnerRows>[0][number]>) => ({
    id: "row-1",
    ownerUserId: null,
    ownerOrganizationId: null,
    endedAt: null,
    ...over,
  });

  it("accepts an org-owned row named as the authoring organisation", () => {
    expect(
      unexplainedOwnerRows(
        [row({ ownerOrganizationId: ORG })],
        [{ recordedByUserId: TITULAR_ID, authorOrganizationId: ORG, payload: {} }],
      ),
    ).toEqual([]);
  });

  it("finds a subject nested in arrays inside the payload", () => {
    expect(
      unexplainedOwnerRows(
        [row({ ownerUserId: TITULAR_ID })],
        [
          {
            recordedByUserId: null,
            authorOrganizationId: null,
            payload: { parties: [{ id: TITULAR_ID }] },
          },
        ],
      ),
    ).toEqual([]);
  });

  it("does not accept a payload KEY that happens to equal the subject", () => {
    expect(
      unexplainedOwnerRows(
        [row({ ownerUserId: TITULAR_ID, endedAt: NOW })],
        [{ recordedByUserId: null, authorOrganizationId: null, payload: { [TITULAR_ID]: true } }],
      ),
    ).toEqual([expect.stringContaining("ended owner row")]);
  });

  it("flags an owner row that names neither a user nor an org", () => {
    expect(unexplainedOwnerRows([row({})], [])).toEqual([
      expect.stringContaining("names neither a user nor an org"),
    ]);
  });
});
