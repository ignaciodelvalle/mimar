// The name pass, applied (PO decision 2026-10-06): over unresolved
// event_places rows in the spine backfill's shape, ONLY a name that names
// exactly one live catalogue row in its province gets its id, with the
// resolver's own method. A homonym, an unknown name, and any row the 0250
// trigger projected from an event's own `place` are left exactly as they were.
// The write goes in batches of APPLY_BATCH rows, and a second run writes
// nothing.
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

async function insertEvent(tx: Tx, petId: string, payload: unknown): Promise<string> {
  const [ev] = (await tx.execute(sql`
    insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
    values (${petId}::uuid, 'note_added', now(), 'system', ${JSON.stringify(payload)}::jsonb)
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return (ev as { id: string }).id;
}

/**
 * An event with no place, and the unresolved spine-shaped row the backfill
 * would write for it. `provinceCode` null = the backfill could not code the
 * entered province, so the pass must read the entered text itself.
 */
async function seedSpineRow(
  tx: Tx,
  petId: string,
  provinceCode: string | null,
  province: string,
  locality: string,
): Promise<string> {
  const eventId = await insertEvent(tx, petId, { text: "name pass fence" });
  await tx.execute(sql`
    insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
    values (${eventId}::uuid, ${petId}::uuid, ${provinceCode}, null, 'unresolved',
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

describe("the name pass writes only spine rows whose name names one row", () => {
  it("resolves the unique name in batches, leaves the homonym, the unknown name and the trigger's row, and is idempotent", async () => {
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
        uniqueIds.push(await seedSpineRow(tx, petId, "AR-B", "Buenos Aires", "Quilmes"));
      }
      const homonym = await seedSpineRow(tx, petId, "AR-B", "Buenos Aires", "Mechita");
      const unknown = await seedSpineRow(tx, petId, "AR-B", "Buenos Aires", "Villa Que No Existe");
      // The 0250 trigger projects an event's own place: same unique name, but
      // "unresolved" there is the writer's verdict, not a missing id.
      const triggered = await insertEvent(tx, petId, {
        text: "name pass fence",
        place: { entered: { province: "Buenos Aires", locality: "Quilmes", indec_id: null } },
      });
      const before = {
        homonym: await placeOf(tx, homonym),
        unknown: await placeOf(tx, unknown),
        triggered: await placeOf(tx, triggered),
      };
      expect(before.triggered, "the trigger must have projected it").toMatchObject({
        province_code: "AR-B",
        locality_id: null,
        method: "unresolved",
      });

      const inv = await inventoryNamePass(tx, { petIds: [petId] });
      expect(inv.rowsByShape).toEqual({ spine: APPLY_BATCH + 3, event_place: 1, unknown: 0 });
      expect(inv.projection.rows).toEqual({ unique: APPLY_BATCH + 2, ambiguous: 1, none: 1 });
      expect(inv.projection.write).toEqual({
        rows: APPLY_BATCH + 1,
        exactRows: APPLY_BATCH + 1,
        foldedRows: 0,
      });
      expect(inv.projection.heldUniqueRows).toBe(1);

      const first = await applyNamePass(tx, inv);
      expect(first).toEqual({ batches: 2, updated: APPLY_BATCH + 1, skipped: 0 });

      for (const id of uniqueIds) {
        expect(await placeOf(tx, id)).toMatchObject({
          province_code: "AR-B",
          locality_id: quilmes[0],
          method: "exact_name_unique",
        });
      }
      expect(await placeOf(tx, homonym)).toEqual(before.homonym);
      expect(await placeOf(tx, unknown)).toEqual(before.unknown);
      expect(await placeOf(tx, triggered)).toEqual(before.triggered);

      // A re-run (or a resumed one) finds nothing left to write.
      const again = await inventoryNamePass(tx, { petIds: [petId] });
      expect(again.projection.write.rows).toBe(0);
      expect(await applyNamePass(tx, again)).toEqual({ batches: 0, updated: 0, skipped: 0 });
      // Even a stale inventory replayed writes nothing: every row is re-checked.
      expect(await applyNamePass(tx, inv)).toEqual({
        batches: 2,
        updated: 0,
        skipped: APPLY_BATCH + 1,
      });
    });
  });

  it("reads an uncoded entered province by name or alias, and lands on that province's row", async () => {
    await inRolledBackTx(async (tx) => {
      const villaMaria = await liveRows(tx, "AR-X", "Villa María");
      const palermo = await liveRows(tx, "AR-C", "Palermo");
      expect(villaMaria, "Villa María must name one live Córdoba row").toHaveLength(1);
      expect(palermo, "Palermo must name one live CABA row").toHaveLength(1);

      const petId = await aCleanPet(tx);
      // No province_code on the row: the pass must code "Córdoba" (a name)
      // and "Capital Federal" (an alias of CABA) itself.
      const byName = await seedSpineRow(tx, petId, null, "Córdoba", "Villa María");
      const byAlias = await seedSpineRow(tx, petId, null, "Capital Federal", "Palermo");

      const inv = await inventoryNamePass(tx, { petIds: [petId] });
      expect(inv.projection.write.rows).toBe(2);
      expect(await applyNamePass(tx, inv)).toEqual({ batches: 1, updated: 2, skipped: 0 });

      expect(await placeOf(tx, byName)).toMatchObject({
        province_code: "AR-X",
        locality_id: villaMaria[0],
        method: "exact_name_unique",
      });
      expect(await placeOf(tx, byAlias)).toMatchObject({
        province_code: "AR-C",
        locality_id: palermo[0],
        method: "exact_name_unique",
      });
    });
  });
});
