// The coordinate pass against the real catalogue (plan maestro A2).
//
// Two real homonyms, chosen for opposite reasons:
//   - "Las Vertientes" (Córdoba): two live rows ~197 km apart. A spine row
//     whose event point sits next to one of them is settled; with no point,
//     with a point far from both, it stays unresolved.
//   - "Mechita" (Buenos Aires, partidos Alberti and Bragado): two live rows
//     whose centroids are ~1 km apart — ONE town on a partido border. No
//     point can tell them apart, and the pass must say so instead of picking.
// A unique name is the name pass's business and is not counted here. Reads
// only; everything seeded is rolled back (pet_events is append-only and the
// local database is shared).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { inventoryCoordinatePass } from "@/lib/place/event-places-coordinate-pass";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = { id: string; lat: number | null; lng: number | null };

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

async function liveRows(tx: Tx, provinceCode: string, name: string): Promise<Row[]> {
  return (await tx.execute(sql`
    select id::text as id, latitude::float8 as lat, longitude::float8 as lng
      from public.ar_localities
     where province_code = ${provinceCode} and locality_name = ${name} and removed_at is null
     order by department_name
  `)) as unknown as Row[];
}

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

/** An event (optionally with a point) and its unresolved spine-shaped row. */
async function seedSpineRow(
  tx: Tx,
  petId: string,
  place: { code: string; province: string; locality: string },
  point: { lat: number; lng: number } | null,
): Promise<string> {
  const [ev] = (await tx.execute(sql`
    insert into public.pet_events
      (pet_id, event_type, occurred_at, author_role, payload, location_lat, location_lng)
    values (${petId}::uuid, 'note_added', now(), 'system', '{"text":"coordinate pass fence"}'::jsonb,
            ${point?.lat ?? null}::numeric, ${point?.lng ?? null}::numeric)
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const eventId = (ev as { id: string }).id;
  await tx.execute(sql`
    insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
    values (${eventId}::uuid, ${petId}::uuid, ${place.code}, null, 'unresolved',
            jsonb_build_object('province', ${place.province}::text, 'locality', ${place.locality}::text,
                               'source', 'spine', 'spine_event_id', ${eventId}::text))
  `);
  return eventId;
}

const VERTIENTES = { code: "AR-X", province: "Córdoba", locality: "Las Vertientes" };
const MECHITA = { code: "AR-B", province: "Buenos Aires", locality: "Mechita" };
const QUILMES = { code: "AR-B", province: "Buenos Aires", locality: "Quilmes" };

describe("the coordinate pass over real homonyms", () => {
  it("settles a far-apart homonym only next to one candidate, refuses a border town, never writes", async () => {
    await inRolledBackTx(async (tx) => {
      const vertientes = await liveRows(tx, VERTIENTES.code, VERTIENTES.locality);
      expect(vertientes, "Las Vertientes must name two live Córdoba rows").toHaveLength(2);
      const mechita = await liveRows(tx, MECHITA.code, MECHITA.locality);
      expect(mechita, "Mechita must name two live Buenos Aires rows").toHaveLength(2);
      for (const r of [...vertientes, ...mechita]) {
        expect(r.lat !== null && r.lng !== null, "every candidate needs a centroid").toBe(true);
      }
      const [v1, v2] = vertientes as [Row, Row];
      const [m1] = mechita as [Row, Row];

      const petId = await aCleanPet(tx);
      const nearV1 = await seedSpineRow(tx, petId, VERTIENTES, {
        lat: (v1.lat as number) + 0.02,
        lng: v1.lng as number,
      });
      const nearV2 = await seedSpineRow(tx, petId, VERTIENTES, {
        lat: v2.lat as number,
        lng: (v2.lng as number) - 0.02,
      });
      const noPoint = await seedSpineRow(tx, petId, VERTIENTES, null);
      const farAway = await seedSpineRow(tx, petId, VERTIENTES, { lat: -24.8, lng: -65.4 });
      const border = await seedSpineRow(tx, petId, MECHITA, {
        lat: m1.lat as number,
        lng: m1.lng as number,
      });
      // A unique name is the name pass's business: not counted here.
      await seedSpineRow(tx, petId, QUILMES, { lat: -34.72, lng: -58.25 });

      const countUnresolved = () =>
        tx.execute(sql`
          select count(*)::int as n from public.event_places
           where pet_id = ${petId}::uuid and method = 'unresolved'`);
      const before = await countUnresolved();

      const inv = await inventoryCoordinatePass(tx, { petIds: [petId] });
      expect(inv.unresolvedRows).toBe(6);
      expect(inv.homonymRows).toBe(5);
      expect(inv.pairs.map((p) => [p.provinceCode, p.locality, p.rows])).toEqual([
        ["AR-X", "Las Vertientes", 4],
        ["AR-B", "Mechita", 1],
      ]);

      const byEvent = new Map(inv.decisions.map((d) => [d.eventId, d.decision]));
      expect(byEvent.get(nearV1)).toMatchObject({ verdict: "resolved", localityId: v1.id });
      expect(byEvent.get(nearV2)).toMatchObject({ verdict: "resolved", localityId: v2.id });
      expect(byEvent.get(noPoint)).toMatchObject({ verdict: "unresolved", reason: "no_coords" });
      expect(byEvent.get(farAway)).toMatchObject({ verdict: "unresolved", reason: "outside_all" });
      // Standing ON one Mechita centroid still cannot name the partido.
      expect(byEvent.get(border)).toMatchObject({
        verdict: "unresolved",
        reason: "too_close_to_call",
      });
      expect(inv.totals).toMatchObject({ resolved: 2, resolvedWritable: 2 });

      // Dry run: nothing moved.
      expect(await countUnresolved()).toEqual(before);
    });
  });
});
