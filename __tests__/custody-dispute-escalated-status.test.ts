// custody_disputes can hold 'escalated' (finding A09-3, migration 0235).
//
// escalate-stale-disputes moves the linked `cases` row to 'escalated', and the
// dispute row could not follow: custody_disputes_status_valid allowed only
// open / resolved / withdrawn. Widening that CHECK alone would have been a lie,
// because custody_disputes_resolution_consistent admitted only two shapes, so
// both constraints widened together and 'escalated' takes the unresolved shape.
//
// What is asserted:
//   1. Parity — the DB CHECK accepts exactly DISPUTE_STATUSES, both directions.
//   2. An 'escalated' row with the unresolved shape is accepted.
//   3. An 'escalated' row carrying a resolver is refused.
// Every write runs inside a transaction that is rolled back, so the fixture
// leaves nothing behind (pet_events is append-only; a rollback is not a delete).
//
// Nothing in the app WRITES 'escalated' yet — see the 0235 header for the
// reader contract that has to move first.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { DISPUTE_STATUSES, custodyDisputes, db, petEvents, pets } from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";

class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertDispute(
  tx: Tx,
  shape: { resolvedAt: Date | null; resolvedByUserId: string | null },
): Promise<void> {
  const token = `ESC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const [pet] = await tx
    .insert(pets)
    .values({ publicToken: token, name: "Escalada", species: "dog" })
    .returning({ id: pets.id });
  const now = new Date();
  const [event] = await tx
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "custody_dispute_raised",
      occurredAt: now,
      recordedAt: now,
      authorRole: "system",
      payload: {},
    })
    .returning({ id: petEvents.id });
  await tx.insert(custodyDisputes).values({
    publicToken: token,
    petId: pet.id,
    raisedByRole: "admin",
    raisingEventId: event.id,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
    status: "escalated",
    resolvedAt: shape.resolvedAt,
    resolvedByUserId: shape.resolvedByUserId,
  });
}

async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe("custody_disputes 'escalated' status", () => {
  it("the CHECK accepts exactly DISPUTE_STATUSES", async () => {
    const [row] = (await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'custody_disputes_status_valid'
    `)) as unknown as Array<{ def: string }>;
    const inDb = [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...DISPUTE_STATUSES].sort());
    expect(inDb).toContain("escalated");
  });

  it("accepts an escalated dispute with the unresolved shape", async () => {
    await rolledBack((tx) => insertDispute(tx, { resolvedAt: null, resolvedByUserId: null }));
  });

  it("refuses an escalated dispute that carries a resolver", async () => {
    const [admin] = (await db.execute(sql`
      select p.id::text as id from public.profiles p
      join auth.users u on u.id = p.id where u.email = 'admin@dim.test' limit 1
    `)) as unknown as Array<{ id: string }>;
    await expectDbError(
      db.transaction((tx) =>
        insertDispute(tx, { resolvedAt: new Date(), resolvedByUserId: admin.id }),
      ),
      { constraint: /custody_disputes_resolution_consistent/ },
    );
  });
});
