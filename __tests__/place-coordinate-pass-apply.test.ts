// The coordinate pass, applied (plan maestro A2; method value 0291).
//
// Over unresolved event_places rows whose name is a homonym, apply writes
// ONLY the rows the dry run marks resolved AND that are in the spine
// backfill's shape, with method `homonym_by_coordinates` and one
// place_resolutions row each. Everything else is left exactly as it was:
//   - a row with no point, a point far from both candidates;
//   - Mechita (Buenos Aires, partidos Alberti and Bragado): centroids ~1 km
//     apart, so even a point ON one of them is too close to call — never
//     written;
//   - a row in the 0250 trigger's shape, even with a point next to one
//     candidate (it can be a deliberate verdict of the report policy);
//   - a unique name (the name pass's business).
// A second run writes nothing and appends no audit row. And the operator
// script refuses to write a remote database without --allow-remote, before it
// opens a connection.
//
// Everything runs inside one transaction that is rolled back (each apply batch
// is a savepoint): pet_events is append-only and the local database is shared.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  COORDINATE_METHOD,
  applyCoordinatePass,
  coordinateTargets,
  inventoryCoordinatePass,
} from "@/lib/place/event-places-coordinate-pass";

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

type Place = { code: string; province: string; locality: string };

/** An event (optionally with a point) and its unresolved row, spine- or trigger-shaped. */
async function seedRow(
  tx: Tx,
  petId: string,
  place: Place,
  point: { lat: number; lng: number } | null,
  shape: "spine" | "trigger" = "spine",
): Promise<string> {
  const [ev] = (await tx.execute(sql`
    insert into public.pet_events
      (pet_id, event_type, occurred_at, author_role, payload, location_lat, location_lng)
    values (${petId}::uuid, 'note_added', now(), 'system', '{"text":"coordinate apply fence"}'::jsonb,
            ${point?.lat ?? null}::numeric, ${point?.lng ?? null}::numeric)
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const eventId = (ev as { id: string }).id;
  const entered =
    shape === "spine"
      ? sql`jsonb_build_object('province', ${place.province}::text, 'locality', ${place.locality}::text,
                               'source', 'spine', 'spine_event_id', ${eventId}::text)`
      : sql`jsonb_build_object('province', ${place.province}::text, 'locality', ${place.locality}::text)`;
  await tx.execute(sql`
    insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
    values (${eventId}::uuid, ${petId}::uuid, ${place.code}, null, 'unresolved', ${entered})
  `);
  return eventId;
}

type Placed = { eventId: string; method: string; localityId: string | null };

async function placesOf(tx: Tx, petId: string): Promise<Map<string, Placed>> {
  const rows = (await tx.execute(sql`
    select event_id::text as "eventId", method, locality_id::text as "localityId"
      from public.event_places where pet_id = ${petId}::uuid
  `)) as unknown as Placed[];
  return new Map(rows.map((r) => [r.eventId, r]));
}

async function auditOf(
  tx: Tx,
  eventIds: readonly string[],
): Promise<Array<{ subjectId: string; localityId: string; method: string; actor: string | null }>> {
  return (await tx.execute(sql`
    select subject_id::text as "subjectId", locality_id::text as "localityId", method,
           actor_user_id::text as actor
      from public.place_resolutions
     where subject_table = 'event_places'
       and subject_id in (${sql.join(
         eventIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     order by subject_id
  `)) as unknown as Array<{
    subjectId: string;
    localityId: string;
    method: string;
    actor: string | null;
  }>;
}

const VERTIENTES: Place = { code: "AR-X", province: "Córdoba", locality: "Las Vertientes" };
const MECHITA: Place = { code: "AR-B", province: "Buenos Aires", locality: "Mechita" };
const QUILMES: Place = { code: "AR-B", province: "Buenos Aires", locality: "Quilmes" };

describe("the coordinate pass, applied", () => {
  it("writes exactly the resolved spine rows, audits each, never Mechita, and a re-run is a no-op", async () => {
    await inRolledBackTx(async (tx) => {
      const vertientes = await liveRows(tx, VERTIENTES.code, VERTIENTES.locality);
      expect(vertientes, "Las Vertientes must name two live Córdoba rows").toHaveLength(2);
      const mechita = await liveRows(tx, MECHITA.code, MECHITA.locality);
      expect(mechita, "Mechita must name two live Buenos Aires rows").toHaveLength(2);
      const [v1, v2] = vertientes as [Row, Row];
      const [m1, m2] = mechita as [Row, Row];

      const petId = await aCleanPet(tx);
      const nearV1 = await seedRow(tx, petId, VERTIENTES, {
        lat: (v1.lat as number) + 0.02,
        lng: v1.lng as number,
      });
      const nearV2 = await seedRow(tx, petId, VERTIENTES, {
        lat: v2.lat as number,
        lng: (v2.lng as number) - 0.02,
      });
      const noPoint = await seedRow(tx, petId, VERTIENTES, null);
      const farAway = await seedRow(tx, petId, VERTIENTES, { lat: -24.8, lng: -65.4 });
      // Next to V1, but in the trigger's shape: counted, never written.
      const triggerShaped = await seedRow(
        tx,
        petId,
        VERTIENTES,
        { lat: v1.lat as number, lng: v1.lng as number },
        "trigger",
      );
      // Standing ON each Mechita centroid still cannot name the partido.
      const onM1 = await seedRow(tx, petId, MECHITA, {
        lat: m1.lat as number,
        lng: m1.lng as number,
      });
      const onM2 = await seedRow(tx, petId, MECHITA, {
        lat: m2.lat as number,
        lng: m2.lng as number,
      });
      const unique = await seedRow(tx, petId, QUILMES, { lat: -34.72, lng: -58.25 });

      const before = await placesOf(tx, petId);
      const inv = await inventoryCoordinatePass(tx, { petIds: [petId] });
      expect(inv.totals).toMatchObject({ resolved: 3, resolvedWritable: 2 });
      const mechitaPair = inv.pairs.find((p) => p.locality === MECHITA.locality);
      expect(mechitaPair?.byReason.too_close_to_call).toBe(2);
      expect(mechitaPair?.resolvedWritableRows).toBe(0);

      const targets = coordinateTargets(inv);
      expect(targets.map((t) => t.eventId).sort()).toEqual([nearV1, nearV2].sort());

      const res = await applyCoordinatePass(tx, targets);
      expect(res).toMatchObject({ batches: 1, updated: 2, skipped: 0 });
      expect(res.updatedByPair).toEqual({ [`${VERTIENTES.code}\u0000${VERTIENTES.locality}`]: 2 });

      const after = await placesOf(tx, petId);
      expect(after.get(nearV1)).toMatchObject({ method: COORDINATE_METHOD, localityId: v1.id });
      expect(after.get(nearV2)).toMatchObject({ method: COORDINATE_METHOD, localityId: v2.id });
      // Nothing else moved.
      for (const id of [noPoint, farAway, triggerShaped, onM1, onM2, unique]) {
        expect(after.get(id), id).toEqual(before.get(id));
        expect(after.get(id)?.method).toBe("unresolved");
      }

      // The audit trail: one append-only row per written row, no actor.
      const audit = await auditOf(tx, [nearV1, nearV2, noPoint, triggerShaped, onM1, onM2]);
      expect(audit).toEqual(
        [
          { subjectId: nearV1, localityId: v1.id, method: COORDINATE_METHOD, actor: null },
          { subjectId: nearV2, localityId: v2.id, method: COORDINATE_METHOD, actor: null },
        ].sort((a, b) => a.subjectId.localeCompare(b.subjectId)),
      );

      // Re-run: the fresh inventory no longer sees the settled rows...
      const again = await inventoryCoordinatePass(tx, { petIds: [petId] });
      expect(coordinateTargets(again)).toEqual([]);
      expect(await applyCoordinatePass(tx, coordinateTargets(again))).toMatchObject({
        updated: 0,
        skipped: 0,
      });
      // ...and replaying the STALE targets is skipped row by row, never rewritten.
      expect(await applyCoordinatePass(tx, targets)).toMatchObject({ updated: 0, skipped: 2 });
      expect(await placesOf(tx, petId)).toEqual(after);
      expect(await auditOf(tx, [nearV1, nearV2])).toHaveLength(2);
    });
  });
});

describe("the operator script, against a remote database", () => {
  // tsx cold start can take seconds on a slow runner (migrate-runner.test.ts).
  it("refuses --apply without --allow-remote, before connecting", { timeout: 30_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coord-pass-"));
    try {
      const envFile = path.join(dir, ".env.remote");
      // A remote-shaped URL on a reserved TLD: refused before any connection.
      writeFileSync(
        envFile,
        "DATABASE_URL=postgresql://postgres.abcdefghijklmnopqrst:x@db.invalid:5432/postgres\n",
      );
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/register-server-only-stub.mjs",
          "--import",
          "tsx",
          "scripts/place-resolve-event-places-by-coordinates.ts",
          "--apply",
          "--env-file",
          envFile,
        ],
        { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
      );
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toContain("refusing");
      expect(run.stderr).toContain("--allow-remote to write");
      // The remote host from the env file, not the unparseable-URL refusal.
      expect(run.stderr).toContain("db.invalid");
      expect(run.stdout).not.toContain("applying");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
