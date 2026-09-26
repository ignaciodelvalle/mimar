// Panorama attribution by catalogue id (localidades-por-id D6, spec
// "panorama-geography").
//
// On the name path the choropleth groups pets by (province, locality NAME) and
// pins one department with MIN(): the two Mechitas of Buenos Aires (partido
// Alberti and partido Bragado) are one cell, attributed to whichever
// department sorts first. On the id path (flag `panorama`) each catalogue row
// is its own locality with its own department, and a pet whose place never
// resolved is counted in a per-province "Sin localidad" cell — never guessed
// into a homonym, never dropped.
//
// Rolled back (shared DB); the path is asked explicitly, the flag untouched.

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, pets } from "@/db";

import { SIN_LOCALIDAD } from "../place-attribution";
import { rollupPetsPerLocality } from "../repository-choropleth";

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

async function localityId(tx: Tx, indecId: string): Promise<string> {
  const rows = (await tx.execute(
    sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
  )) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

const PROBE = "D6 attribution probe";

async function pet(tx: Tx, id: string | null): Promise<void> {
  await tx.insert(pets).values({
    publicToken: `DIM-D6${randomUUID().slice(0, 2).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
    name: PROBE,
    species: "dog",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Mechita",
    localityId: id,
  });
}

describe("rollupPetsPerLocality — attribution by id (D6)", () => {
  it("splits the Mechita homonym by department and buckets the unresolved pet", async () => {
    await inRolledBackTx(async (tx) => {
      await pet(tx, await localityId(tx, "06021030"));
      await pet(tx, await localityId(tx, "06112080"));
      await pet(tx, null);
      const probe = [eq(pets.name, PROBE)];

      const byName = await rollupPetsPerLocality(probe, null, { mode: "name", exec: tx });
      expect(byName.map((r) => [r.locality, r.count])).toEqual([["Mechita", 3]]);

      const byId = await rollupPetsPerLocality(probe, null, { mode: "id", exec: tx });
      const cells = byId
        .map((r) => [r.locality, r.departmentName, r.count] as const)
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      expect(cells).toEqual([
        ["Mechita", "Alberti", 1],
        ["Mechita", "Bragado", 1],
        [SIN_LOCALIDAD, null, 1],
      ]);
      const sinLocalidad = byId.find((r) => r.locality === SIN_LOCALIDAD);
      expect(sinLocalidad?.province).toBe("Buenos Aires");
      // It still sits on the map: the province's representative point.
      expect(sinLocalidad?.centroidLat).not.toBeNull();
      // Every pet is counted exactly once on both paths.
      expect(byId.reduce((n, r) => n + r.count, 0)).toBe(3);
    });
  });
});
