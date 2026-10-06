// The name pass, applied (PO decision 2026-10-06): over unresolved
// event_places rows in the spine backfill's shape, ONLY a name that names
// exactly one live catalogue row in its province gets its id (method
// legacy_unique_name). A homonym and an unknown name are left exactly as they
// were. The write goes in batches of APPLY_BATCH rows, and a second run
// writes nothing.
//
// The homonym is Mechita (Buenos Aires: partido Alberti and partido Bragado).
// "San Martín" is NOT a homonym in this catalogue — it names one row in each
// of five provinces, never two in one — so it cannot stand in for one.
//
// Everything runs inside one transaction that is rolled back (each apply batch
// is a savepoint): pet_events is append-only and the local database is shared,
// so a rollback is the only clean-up there is.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { APPLY_BATCH, applyNamePass, inventoryNamePass } from "@/lib/place/event-places-name-pass";

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

async function liveRows(tx: Tx, provinceCode: string, name: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.ar_localities
     where province_code = ${provinceCode} and locality_name = ${name} and removed_at is null
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** A pet with no unresolved place rows, so the scoped pass sees only ours. */
async function aCleanPet(tx: Tx): Promise<string> {
  const rows = (await tx.execute(sql`
    select pt.id::text as id from public.pets pt
     where not exists (select 1 from public.event_places p
                        where p.pet_id = pt.id and p.method = 'unresolved')
     order by pt.created_at limit 1
  `)) as unknown as Array<{ id: string }>;
  expect(rows, "the local database must have a pet").toHaveLength(1);
  return (rows[0] as { id: string }).id;
}

/** An event with no place, and the unresolved spine-shaped row the backfill would write. */
async function seedUnresolved(
  tx: Tx,
  petId: string,
  province: string,
  locality: string,
): Promise<string> {
  const [ev] = (await tx.execute(sql`
    insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
    values (${petId}::uuid, 'note_added', now(), 'system', '{"text":"name pass fence"}'::jsonb)
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const eventId = (ev as { id: string }).id;
  await tx.execute(sql`
    insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
    values (${eventId}::uuid, ${petId}::uuid, 'AR-B', null, 'unresolved',
            jsonb_build_object('province', ${province}::text, 'locality', ${locality}::text,
                               'source', 'spine', 'spine_event_id', ${eventId}::text))
  `);
  return eventId;
}

async function placeOf(tx: Tx, eventId: string) {
  const [row] = (await tx.execute(sql`
    select province_code, locality_id::text as locality_id, method, entered
      from public.event_places where event_id = ${eventId}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  return row;
}

describe("the name pass writes only names that name one row", () => {
  it("resolves the unique name in batches, leaves the homonym and the unknown name, and is idempotent", async () => {
    await inRolledBackTx(async (tx) => {
      // Preconditions straight from the catalogue, not from the resolver.
      const quilmes = await liveRows(tx, "AR-B", "Quilmes");
      expect(quilmes, "Quilmes must name one live Buenos Aires row").toHaveLength(1);
      const mechita = await liveRows(tx, "AR-B", "Mechita");
      expect(mechita, "Mechita must name two live rows").toHaveLength(2);
      expect(await liveRows(tx, "AR-B", "Villa Que No Existe")).toHaveLength(0);

      const petId = await aCleanPet(tx);
      const uniqueIds: string[] = [];
      for (let i = 0; i < APPLY_BATCH + 1; i++) {
        uniqueIds.push(await seedUnresolved(tx, petId, "Buenos Aires", "Quilmes"));
      }
      const homonym = await seedUnresolved(tx, petId, "Buenos Aires", "Mechita");
      const unknown = await seedUnresolved(tx, petId, "Buenos Aires", "Villa Que No Existe");
      const homonymBefore = await placeOf(tx, homonym);
      const unknownBefore = await placeOf(tx, unknown);

      const inv = await inventoryNamePass(tx, { petIds: [petId] });
      expect(inv.projection.rows).toEqual({ unique: APPLY_BATCH + 1, ambiguous: 1, none: 1 });
      expect(inv.projection.after.unresolved).toBe(inv.projection.before.unresolved - 51);

      const first = await applyNamePass(tx, inv);
      expect(first).toEqual({ batches: 2, updated: APPLY_BATCH + 1, skipped: 0 });

      for (const id of uniqueIds) {
        expect(await placeOf(tx, id)).toMatchObject({
          province_code: "AR-B",
          locality_id: quilmes[0],
          method: "legacy_unique_name",
        });
      }
      expect(await placeOf(tx, homonym)).toEqual(homonymBefore);
      expect(await placeOf(tx, unknown)).toEqual(unknownBefore);
      expect(homonymBefore).toMatchObject({ locality_id: null, method: "unresolved" });

      // A re-run (or a resumed one) finds nothing left to write.
      const again = await inventoryNamePass(tx, { petIds: [petId] });
      expect(again.projection.rows).toEqual({ unique: 0, ambiguous: 1, none: 1 });
      expect(await applyNamePass(tx, again)).toEqual({ batches: 0, updated: 0, skipped: 0 });
      // Even a stale inventory replayed writes nothing: every row is re-checked.
      expect(await applyNamePass(tx, inv)).toEqual({
        batches: 2,
        updated: 0,
        skipped: APPLY_BATCH + 1,
      });
    });
  });
});
