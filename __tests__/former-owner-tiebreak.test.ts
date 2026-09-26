// The immediate former owner after a decomiso is chosen deterministically
// (custody audit S6 / stage D verify S6).
//
// findImmediateFormerOwnerOwnership picks the most recently ENDED holder row.
// When two holder rows of the same pet ended at the same instant — the owner
// and a caretaker closed together by the seizure — ordering by ended_at alone
// let Postgres pick either, so a custody return could reactivate the
// caretaker instead of the titular. The owner wins the tie; then the row id,
// so the answer never depends on the plan. Rolled back.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, ownerships, pets } from "@/db";
import { findImmediateFormerOwnerOwnership } from "@/lib/infra/pet-access";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
}

describe("findImmediateFormerOwnerOwnership — a tie on ended_at", () => {
  it("the owner row wins over a caretaker closed at the same instant", async () => {
    await inRolledBackTx(async (tx) => {
      const people = (await tx.execute(sql`
        select id::text as id from public.profiles
         where not is_system and role = 'owner' and account_type = 'personal'
           and deactivated_at is null and deleted_at is null
         order by created_at limit 2
      `)) as unknown as Array<{ id: string }>;
      expect(people.length).toBe(2);
      const [owner, caretaker] = people.map((p) => p.id) as [string, string];
      const [pet] = await tx
        .insert(pets)
        .values({
          publicToken: `TIE-${Date.now()}`,
          name: "Empate",
          species: "dog",
          sex: "male",
          status: "active",
        })
        .returning({ id: pets.id });
      const petId = pet?.id as string;
      const endedAt = new Date("2026-09-01T12:00:00.000Z");
      const startedAt = new Date("2026-01-01T12:00:00.000Z");
      // The caretaker row is inserted FIRST, so a plan that returns insertion
      // order (or the smaller id, if it sorts first) would pick it.
      const rows = await tx
        .insert(ownerships)
        .values([
          { petId, ownerUserId: caretaker, role: "caretaker", startedAt, endedAt },
          { petId, ownerUserId: owner, role: "owner", startedAt, endedAt },
        ])
        .returning({ id: ownerships.id, role: ownerships.role });
      const ownerRow = rows.find((r) => r.role === "owner");
      const found = await findImmediateFormerOwnerOwnership(petId, tx);
      expect(found).toEqual({ id: ownerRow?.id, ownerUserId: owner });
    });
  });
});
