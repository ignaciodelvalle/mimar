// Fence: `homonym_by_coordinates` (migration 0291) is a method the
// event_places projection and its audit trail accept — and ONLY those two.
//
//   1. event_places.method and place_resolutions.method list exactly
//      EVENT_PLACE_METHODS (lib/domain/place.ts), in order, on the live
//      database: the vocabulary cannot grow on one side only.
//   2. Both tables take a row with the new method.
//   3. A place column (pets.place_method, one of the 0248 CHECKs) still refuses
//      it: no writer of a record's own place may claim that a point settled a
//      homonym. The 0248 lists themselves are __tests__/place-columns.test.ts.
//
// Every write is rolled back (pet_events is append-only and the local database
// is shared).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { EVENT_PLACE_METHODS, PLACE_METHODS } from "@/lib/domain/place";

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

async function listed(table: string, conname: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select pg_get_constraintdef(c.oid) as def
      from pg_catalog.pg_constraint c
     where c.contype = 'c'
       and c.conrelid = ${`public.${table}`}::regclass
       and c.conname = ${conname}
  `)) as unknown as Array<{ def: string }>;
  expect(rows, `${table} has ${conname}`).toHaveLength(1);
  return [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string);
}

/** The Postgres error code of a failed statement, through drizzle's wrapper. */
function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

describe("the event_places method vocabulary (0291)", () => {
  it("is PLACE_METHODS plus homonym_by_coordinates, and nothing else", () => {
    expect(EVENT_PLACE_METHODS).toEqual([...PLACE_METHODS, "homonym_by_coordinates"]);
    expect(PLACE_METHODS).not.toContain("homonym_by_coordinates");
  });

  it.each([
    ["event_places", "event_places_method_check"],
    ["place_resolutions", "place_resolutions_method_check"],
  ])("%s lists exactly EVENT_PLACE_METHODS", async (table, conname) => {
    expect(await listed(table, conname)).toEqual([...EVENT_PLACE_METHODS]);
  });

  it("both tables accept a row settled by the event's coordinates", async () => {
    await inRolledBackTx(async (tx) => {
      const [locality] = (await tx.execute(sql`
        select id::text as id, province_code as code from public.ar_localities
         where removed_at is null order by id limit 1
      `)) as unknown as Array<{ id: string; code: string }>;
      const [pet] = (await tx.execute(sql`
        select id::text as id from public.pets order by created_at limit 1
      `)) as unknown as Array<{ id: string }>;
      expect(locality, "the local catalogue must have a row").toBeDefined();
      expect(pet, "the local database must have a pet").toBeDefined();
      const l = locality as { id: string; code: string };
      const [ev] = (await tx.execute(sql`
        insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
        values (${(pet as { id: string }).id}::uuid, 'note_added', now(), 'system',
                '{"text":"0291 method fence"}'::jsonb)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const eventId = (ev as { id: string }).id;

      const placed = (await tx.execute(sql`
        insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
        values (${eventId}::uuid, ${(pet as { id: string }).id}::uuid, ${l.code}, ${l.id}::uuid,
                'homonym_by_coordinates', '{"locality":"0291 fence"}'::jsonb)
        returning method
      `)) as unknown as Array<{ method: string }>;
      expect(placed).toEqual([{ method: "homonym_by_coordinates" }]);

      const audited = (await tx.execute(sql`
        insert into public.place_resolutions (subject_table, subject_id, locality_id, method, reason)
        values ('event_places', ${eventId}::uuid, ${l.id}::uuid, 'homonym_by_coordinates',
                '0291 method fence')
        returning method
      `)) as unknown as Array<{ method: string }>;
      expect(audited).toEqual([{ method: "homonym_by_coordinates" }]);
    });
  });

  it("a record's own place column still refuses it (pets.place_method)", async () => {
    let error: unknown = null;
    await inRolledBackTx(async (tx) => {
      try {
        await tx.execute(sql`
          update public.pets set place_method = 'homonym_by_coordinates'
           where id = (select id from public.pets order by created_at limit 1)
        `);
      } catch (e) {
        error = e;
      }
    });
    expect(pgCode(error), "23514 = check_violation").toBe("23514");
  });
});
