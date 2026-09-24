// pet_caretaker_grants — schema/constraint tests (migration 0189, custodia-temporal).
//
// Live integration tests against the local Postgres stack. Every assertion here
// is about a DB-LEVEL guarantee, not an application rule: the whole reason the
// grant table carries CHECKs and partial uniques is that the application is not
// the only writer (a seed, a script or a future feature can reach the table),
// and invariant #3 says a cache that is dual-written by design gets its own
// constraint at the place consumers read.
//
// Requires: local Supabase stack running + migration 0189 applied.

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EVENT_TYPES, db, ownerships, petCaretakerGrants, pets, profiles } from "@/db";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import { expectDbError } from "./_helpers/expect-db-error";

const PET_TOKEN = "DIM-CGT-0001";
const TITULAR_ID = "0cae7a11-0000-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a11-0000-4000-8000-000000000002";
const OTHER_ID = "0cae7a11-0000-4000-8000-000000000003";

let petId: string;

const STARTS = new Date("2026-09-01T00:00:00Z");
const ENDS = new Date("2026-09-30T00:00:00Z");

function grantValues(overrides: Record<string, unknown> = {}) {
  return {
    publicToken: `CGT-${Math.random().toString(36).slice(2, 12)}`,
    petId,
    grantedByUserId: TITULAR_ID,
    caretakerEmail: "ana@dim-test.local",
    startsAt: STARTS,
    endsAt: ENDS,
    ...overrides,
  } as typeof petCaretakerGrants.$inferInsert;
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM pet_caretaker_grants WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.delete(profiles).where(inArray(profiles.id, [TITULAR_ID, CARETAKER_ID, OTHER_ID]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular CGT", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora CGT", role: "owner" },
    { id: OTHER_ID, displayName: "Otro CGT", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa CGT", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
});

afterAll(async () => {
  await cleanup();
});

async function clearGrants(): Promise<void> {
  await db.delete(petCaretakerGrants).where(eq(petCaretakerGrants.petId, petId));
}

describe("pet_caretaker_grants — table shape", () => {
  it("exists in the public schema", async () => {
    const rows = (await db.execute(
      sql`select to_regclass('public.pet_caretaker_grants') as reg`,
    )) as unknown as Array<{ reg: string | null }>;
    expect(rows[0]?.reg).toBe("pet_caretaker_grants");
  });

  it("defaults status to 'pending' and leaves the accept columns null", async () => {
    await clearGrants();
    const [row] = await db.insert(petCaretakerGrants).values(grantValues()).returning();
    expect(row.status).toBe("pending");
    expect(row.caretakerUserId).toBeNull();
    expect(row.ownershipId).toBeNull();
    expect(row.respondedAt).toBeNull();
    expect(row.reminderSentAt).toBeNull();
    await clearGrants();
  });
});

describe("pet_caretaker_grants — one open invitation, one active caretaker", () => {
  it("rejects a SECOND pending grant on the same pet", async () => {
    await clearGrants();
    await db.insert(petCaretakerGrants).values(grantValues());
    await expectDbError(db.insert(petCaretakerGrants).values(grantValues()), {
      code: "23505",
      constraint: "pet_caretaker_grants_one_pending_per_pet",
    });
    await clearGrants();
  });

  it("rejects a SECOND accepted grant on the same pet", async () => {
    await clearGrants();
    const ownershipId = await openCaretakerOwnership(CARETAKER_ID);
    await db
      .insert(petCaretakerGrants)
      .values(grantValues({ status: "accepted", caretakerUserId: CARETAKER_ID, ownershipId }));
    await expectDbError(
      db
        .insert(petCaretakerGrants)
        .values(grantValues({ status: "accepted", caretakerUserId: OTHER_ID, ownershipId })),
      { code: "23505", constraint: "pet_caretaker_grants_one_accepted_per_pet" },
    );
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });

  it("allows a new pending grant once the previous one reached a terminal status", async () => {
    await clearGrants();
    await db.insert(petCaretakerGrants).values(grantValues({ status: "expired" }));
    await db.insert(petCaretakerGrants).values(grantValues({ status: "rejected" }));
    const [fresh] = await db.insert(petCaretakerGrants).values(grantValues()).returning();
    expect(fresh.status).toBe("pending");
    await clearGrants();
  });
});

describe("pet_caretaker_grants — CHECK constraints", () => {
  it("rejects an end date at or before the start date", async () => {
    await clearGrants();
    await expectDbError(db.insert(petCaretakerGrants).values(grantValues({ endsAt: STARTS })), {
      code: "23514",
      constraint: /pet_caretaker_grants_period/,
    });
  });

  it("rejects an unknown status", async () => {
    await expectDbError(
      db.insert(petCaretakerGrants).values(grantValues({ status: "bogus" as "pending" })),
      { code: "23514", constraint: /pet_caretaker_grants_status/ },
    );
  });

  it("rejects self-designation (granted_by = caretaker)", async () => {
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
    // A VALID accepted row in every other respect — the caretaker and the
    // ownership pointer are both set, so the accept invariant is satisfied and
    // the ONLY constraint left to fire is the self-designation one. Without
    // this the assertion would pass on the wrong CHECK.
    const ownershipId = await openCaretakerOwnership(TITULAR_ID);
    await expectDbError(
      db.insert(petCaretakerGrants).values(
        grantValues({
          status: "accepted",
          caretakerUserId: TITULAR_ID,
          ownershipId,
        }),
      ),
      { code: "23514", constraint: /pet_caretaker_grants_no_self_designation/ },
    );
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });

  it("rejects an accepted grant with no caretaker and no ownership row (accept invariant)", async () => {
    await expectDbError(db.insert(petCaretakerGrants).values(grantValues({ status: "accepted" })), {
      code: "23514",
      constraint: /pet_caretaker_grants_accept/,
    });
  });

  it("rejects a PENDING grant that already carries the accept columns (accept invariant, other direction)", async () => {
    const ownershipId = await openCaretakerOwnership(CARETAKER_ID);
    await expectDbError(
      db
        .insert(petCaretakerGrants)
        .values(grantValues({ caretakerUserId: CARETAKER_ID, ownershipId })),
      { code: "23514", constraint: /pet_caretaker_grants_accept/ },
    );
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });
});

describe("pet_caretaker_grants — alternate public contact, two-key consent", () => {
  it("defaults the caretaker's public-contact consent to NULL (never consented)", async () => {
    await clearGrants();
    const [row] = await db.insert(petCaretakerGrants).values(grantValues()).returning();
    expect(row.publicContactConsentAt).toBeNull();
    await clearGrants();
  });

  it("refuses to record consent on a PENDING grant", async () => {
    // Key 2 is captured AT ACCEPT, where the invitee is already being shown
    // what they are agreeing to. A pending row carrying consent would mean
    // somebody recorded it somewhere else — most likely the titular, on the
    // caretaker's behalf, which is the exact thing the second key exists to
    // prevent.
    await clearGrants();
    await expectDbError(
      db.insert(petCaretakerGrants).values(grantValues({ publicContactConsentAt: new Date() })),
      { code: "23514", constraint: /pet_caretaker_grants_public_contact_consent/ },
    );
  });

  it("records consent on an accepted grant and keeps it after the grant ends", async () => {
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
    const ownershipId = await openCaretakerOwnership(CARETAKER_ID);
    const consentedAt = new Date("2026-09-02T12:00:00Z");
    const [accepted] = await db
      .insert(petCaretakerGrants)
      .values(
        grantValues({
          status: "accepted",
          caretakerUserId: CARETAKER_ID,
          ownershipId,
          publicContactConsentAt: consentedAt,
        }),
      )
      .returning();
    expect(accepted.publicContactConsentAt).toEqual(consentedAt);

    // Ending the grant must not erase the consent record: it is a historical
    // fact about what the caretaker agreed to, not a live permission flag.
    //
    // AMENDED BY 0192. This assertion used to null out caretakerUserId and
    // ownershipId on the way to `ended`, because 0189's biconditional accept
    // CHECK left no other way to get there — and that was the tell nobody read:
    // the ONLY legal ending was one that erased who the caretaker had been. The
    // real ending path (revoke / withdraw / cron) cannot do that and was
    // therefore impossible; C5 hit it on the first transaction. 0192 widened the
    // constraint to `accepted OR ended`, so the pointers now SURVIVE, which is
    // both the honest record and what the caretaker drift harness compares
    // against.
    const [ended] = await db
      .update(petCaretakerGrants)
      .set({ status: "ended", endedAt: new Date(), endedReason: "expired" })
      .where(eq(petCaretakerGrants.id, accepted.id))
      .returning();
    expect(ended.publicContactConsentAt).toEqual(consentedAt);
    expect(ended.caretakerUserId).toBe(CARETAKER_ID);
    expect(ended.ownershipId).toBe(ownershipId);

    // Teardown order matters now: the grant still points at the ownership row,
    // and deleting the row would SET NULL that pointer on an `ended` grant —
    // which the constraint refuses. Grants first, then ownerships.
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });
});

describe("ownerships — one active caretaker per pet", () => {
  it("rejects a second active caretaker ownership row on the same pet", async () => {
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
    await openCaretakerOwnership(CARETAKER_ID);
    await expectDbError(
      db
        .insert(ownerships)
        .values({ petId, ownerUserId: OTHER_ID, role: "caretaker" })
        .returning({ id: ownerships.id }),
      { code: "23505", constraint: "ownerships_one_active_caretaker_per_pet" },
    );
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });

  it("allows a new caretaker once the previous row is closed", async () => {
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
    const first = await openCaretakerOwnership(CARETAKER_ID);
    await db.update(ownerships).set({ endedAt: new Date() }).where(eq(ownerships.id, first));
    const second = await openCaretakerOwnership(OTHER_ID);
    expect(second).toBeTruthy();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });
});

// The reminder scan, run against REAL Postgres rather than a fake repository.
//
// WHY THIS BLOCK EXISTS. `findGrantsNeedingReminder` bounded its window with a
// raw `sql` template on one side and the typed `lte` operator on the other. A
// raw template binds an interpolated value WITHOUT the column's type mapper, so
// the Date reached Postgres as `String(date)` — "Wed Sep 09 2026 04:28:53
// GMT+0000 (Coordinated Universal Time)" — which is not valid `timestamptz`
// input. `expire_caretaker_grants` therefore threw every night from at least
// 2026-09-02 to 2026-09-09, and the ONLY thing that noticed was the cron alert
// channel: the module's own suite drives a fake repository, so nothing ever
// asked Postgres to parse those parameters.
//
// The assertion is deliberately about the CALL SUCCEEDING and returning the row
// it should. A test that only counted rows through a fake would have gone on
// passing through the entire outage.
describe("pet_caretaker_grants — the reminder scan runs against Postgres", () => {
  it("accepts real Date bounds and returns the grant inside the window", async () => {
    await clearGrants();
    // The window the daily job asks for: from now to three days out. The grant
    // ends inside it, is `accepted`, and has never been reminded.
    const now = new Date();
    const endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const ownershipId = await openCaretakerOwnership(CARETAKER_ID);
    const [inserted] = await db
      .insert(petCaretakerGrants)
      .values(
        grantValues({
          status: "accepted",
          caretakerUserId: CARETAKER_ID,
          ownershipId,
          respondedAt: now,
          startsAt: new Date(now.getTime() - 60_000),
          endsAt,
        }),
      )
      .returning({ id: petCaretakerGrants.id });

    const rows = await CaretakersRepository.findGrantsNeedingReminder(now, windowEnd);

    expect(rows.map((r) => r.id)).toContain(inserted.id);
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });

  it("excludes a grant that ends BEFORE the lower bound", async () => {
    await clearGrants();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const ownershipId = await openCaretakerOwnership(CARETAKER_ID);
    const [inserted] = await db
      .insert(petCaretakerGrants)
      .values(
        grantValues({
          status: "accepted",
          caretakerUserId: CARETAKER_ID,
          ownershipId,
          respondedAt: now,
          startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          // Already over: the lower bound is what has to exclude it, and the
          // lower bound is the side that used to be malformed.
          endsAt: new Date(now.getTime() - 60 * 60 * 1000),
        }),
      )
      .returning({ id: petCaretakerGrants.id });

    const rows = await CaretakersRepository.findGrantsNeedingReminder(now, windowEnd);

    expect(rows.map((r) => r.id)).not.toContain(inserted.id);
    await clearGrants();
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
  });
});

describe("event catalog", () => {
  it("carries the two caretaker lifecycle event types", () => {
    expect(EVENT_TYPES).toContain("caretaker_designated");
    expect(EVENT_TYPES).toContain("caretaker_ended");
  });
});

async function openCaretakerOwnership(userId: string): Promise<string> {
  const [row] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: userId, role: "caretaker" })
    .returning({ id: ownerships.id });
  return row.id;
}
