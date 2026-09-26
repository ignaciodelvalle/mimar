// Fence: every CHECK the database holds on the localidades-por-id tables is
// also declared in db/schema.ts, under the same name.
//
// WHY. db:bootstrap runs `drizzle-kit push` BEFORE it replays db/migrations,
// so on a fresh database (CI) a migration's `CREATE TABLE IF NOT EXISTS` is
// skipped for every table schema.ts declares, and only the CHECKs declared in
// schema.ts exist there. A CHECK written only in a migration's CREATE TABLE is
// then silently absent from every freshly bootstrapped database. The names
// compared are the ones Postgres gave the live local tables (inline CHECKs are
// named `<table>_<column>_check`, a multi-column one `<table>_check`).
//
// A table the migrations create but schema.ts does NOT declare is the other
// safe shape: push never creates it, so the migration's CREATE TABLE runs whole
// and every inline CHECK lands. That is asserted too, so moving such a table
// into schema.ts without its CHECKs turns this red.

import { sql } from "drizzle-orm";
import { type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import * as schema from "@/db/schema";

/** Tables whose CHECKs must be mirrored in schema.ts. */
const DECLARED: Record<string, PgTable> = {
  authority_units: schema.authorityUnits,
  authority_unit_localities: schema.authorityUnitLocalities,
  event_places: schema.eventPlaces,
  place_resolutions: schema.placeResolutions,
  place_read_flags: schema.placeReadFlags,
  place_shadow_disagreements: schema.placeShadowDisagreements,
};

/** Tables created only by a migration (0251): never pushed, CHECKs land whole. */
const MIGRATION_ONLY = ["place_repair_preimages"] as const;

function declaredTableNames(): string[] {
  return Object.values(schema)
    .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
    .map((v) => getTableConfig(v as PgTable).name);
}

async function liveChecks(table: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select conname from pg_catalog.pg_constraint
     where contype = 'c' and conrelid = ${`public.${table}`}::regclass
     order by conname
  `)) as unknown as Array<{ conname: string }>;
  return rows.map((r) => r.conname);
}

describe("CHECK constraints declared in db/schema.ts", () => {
  for (const [table, def] of Object.entries(DECLARED)) {
    it(`${table}: every live CHECK is declared, by the same name`, async () => {
      const live = await liveChecks(table);
      expect(live.length, `${table} has CHECKs in the live database`).toBeGreaterThan(0);
      const declared = getTableConfig(def)
        .checks.map((c) => c.name)
        .sort();
      expect(declared).toEqual(live);
    });
  }

  for (const table of MIGRATION_ONLY) {
    it(`${table}: not declared in schema.ts, so its migration creates it with its CHECKs`, async () => {
      expect(declaredTableNames(), "the table detection is not vacuous").toContain("event_places");
      expect(declaredTableNames()).not.toContain(table);
      expect(await liveChecks(table)).toEqual([
        `${table}_reason_check`,
        `${table}_subject_table_check`,
        `${table}_verdict_check`,
      ]);
    });
  }
});
