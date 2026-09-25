// Fence: a place resolved after the fact is a NEW record, never an edit — and
// every place-bearing event is counted where it happened by a projection that
// cannot fail the event (localidades-por-id B4, migration 0250).
//
//   - `place_resolutions` refuses UPDATE, DELETE and TRUNCATE; a correction
//     supersedes the earlier row.
//   - `event_places` is written by trigger in the event's own transaction: a
//     resolved place by id and method, an unresolved one at province level
//     with what was entered; a payload with a bogus id is projected as
//     unresolved rather than failing the insert.
//
// Everything runs inside a transaction that is rolled back: the local database
// is shared, and an append-only row could never be cleaned up.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Run `body` in a transaction that is always rolled back. */
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

/** The error a savepoint-wrapped statement raised, or null. */
async function errorOf(tx: Tx, statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(statement);
    });
    return null;
  } catch (e) {
    let cur = e as { message?: string; cause?: unknown } | null;
    const messages: string[] = [];
    while (cur) {
      if (cur.message) messages.push(cur.message);
      cur = (cur.cause as typeof cur) ?? null;
    }
    return messages.join(" | ");
  }
}

async function aLocality(tx: Tx): Promise<{ id: string; province_code: string }> {
  const rows = (await tx.execute(sql`
    select id::text as id, province_code from public.ar_localities
     where indec_id = '14042170' and removed_at is null
  `)) as unknown as Array<{ id: string; province_code: string }>;
  expect(rows, "Villa María (Córdoba) must be in the local catalogue").toHaveLength(1);
  return rows[0] as { id: string; province_code: string };
}

async function aPet(tx: Tx): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.pets order by created_at limit 1
  `)) as unknown as Array<{ id: string }>;
  expect(rows, "the local database must have a pet").toHaveLength(1);
  return (rows[0] as { id: string }).id;
}

describe("place_resolutions is append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and accepts a superseding row", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await aLocality(tx);
      const [first] = (await tx.execute(sql`
        insert into public.place_resolutions (subject_table, subject_id, locality_id, method, reason)
        values ('welfare_reports', gen_random_uuid(), ${loc.id}::uuid, 'admin_queue', 'fence')
        returning id::text as id, subject_id::text as subject_id
      `)) as unknown as Array<{ id: string; subject_id: string }>;
      expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);

      expect(
        await errorOf(
          tx,
          sql`update public.place_resolutions set reason = 'x' where id = ${first?.id}::uuid`,
        ),
      ).toMatch(/append-only: UPDATE refused/);
      expect(
        await errorOf(tx, sql`delete from public.place_resolutions where id = ${first?.id}::uuid`),
      ).toMatch(/append-only: DELETE refused/);
      expect(await errorOf(tx, sql`truncate public.place_resolutions`)).toMatch(
        /append-only: TRUNCATE refused/,
      );

      // The correction: a new row that supersedes the first one.
      const corrected = (await tx.execute(sql`
        insert into public.place_resolutions
          (subject_table, subject_id, locality_id, method, reason, supersedes_id)
        values ('welfare_reports', ${first?.subject_id}::uuid, null, 'unresolved', 'wrong row',
                ${first?.id}::uuid)
        returning supersedes_id::text as supersedes_id
      `)) as unknown as Array<{ supersedes_id: string }>;
      expect(corrected[0]?.supersedes_id).toBe(first?.id);
    });
  });

  it("refuses a method that claims an id it does not carry", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await errorOf(
          tx,
          sql`insert into public.place_resolutions (subject_table, subject_id, locality_id, method)
              values ('pets', gen_random_uuid(), null, 'admin_queue')`,
        ),
      ).toMatch(/place_resolutions_check|violates check constraint/);
    });
  });
});

describe("event_places projects every place-bearing event, in its transaction", () => {
  async function insertEvent(tx: Tx, petId: string, place: unknown): Promise<string> {
    const [row] = (await tx.execute(sql`
      insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
      values (${petId}::uuid, 'note_added', now(), 'system',
              jsonb_build_object('text', 'fence', 'place', ${JSON.stringify(place)}::jsonb))
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    return (row as { id: string }).id;
  }

  async function projection(tx: Tx, eventId: string) {
    return (await tx.execute(sql`
      select province_code, locality_id::text as locality_id, method, entered
        from public.event_places where event_id = ${eventId}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
  }

  it("a resolved place: its row, its province and how", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await aLocality(tx);
      const petId = await aPet(tx);
      const entered = { province: "Córdoba", locality: "Villa María", indec_id: "14042170" };
      const eventId = await insertEvent(tx, petId, {
        entered,
        resolved: { locality_id: loc.id, province_code: "AR-X", method: "indec_id" },
      });
      expect(await projection(tx, eventId)).toEqual([
        { province_code: "AR-X", locality_id: loc.id, method: "indec_id", entered },
      ]);
    });
  });

  it("an unresolved place: province level, with what was entered kept", async () => {
    await inRolledBackTx(async (tx) => {
      const petId = await aPet(tx);
      const entered = { province: "Buenos Aires", locality: "Mechita", indec_id: null };
      const eventId = await insertEvent(tx, petId, { entered, resolved: null });
      expect(await projection(tx, eventId)).toEqual([
        { province_code: "AR-B", locality_id: null, method: "unresolved", entered },
      ]);
    });
  });

  it("a bogus id never fails the event: it is projected as unresolved", async () => {
    await inRolledBackTx(async (tx) => {
      const petId = await aPet(tx);
      const entered = { province: "AR-X", locality: "Villa María", indec_id: null };
      const eventId = await insertEvent(tx, petId, {
        entered,
        resolved: {
          locality_id: "00000000-0000-4000-8000-000000000000",
          province_code: "AR-X",
          method: "indec_id",
        },
      });
      expect(await projection(tx, eventId)).toEqual([
        { province_code: "AR-X", locality_id: null, method: "unresolved", entered },
      ]);
    });
  });

  it("an event with no place is not projected", async () => {
    await inRolledBackTx(async (tx) => {
      const petId = await aPet(tx);
      const [row] = (await tx.execute(sql`
        insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
        values (${petId}::uuid, 'note_added', now(), 'system', '{"text":"no place"}'::jsonb)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      expect(await projection(tx, (row as { id: string }).id)).toEqual([]);
    });
  });
});
