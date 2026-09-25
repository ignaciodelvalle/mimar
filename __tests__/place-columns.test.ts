// Fence: every table that stores a place can store WHICH catalogue row it is and
// HOW that was decided — and no catalogue row can vanish from under it.
//
// localidades-por-id B1 (migration 0248). Three properties, each checked against
// the local database's catalogue:
//
//   1. Every place table has the id column and the method column.
//   2. EVERY foreign key into `ar_localities` is ON DELETE RESTRICT. SET NULL
//      (0147, 0246) meant a hard-deleted catalogue row silently erased the
//      origin of every row pointing at it (P2). The importer soft-deletes, so
//      RESTRICT only ever turns a mistake into an error.
//   3. The method CHECK is exactly `PLACE_METHODS` (lib/domain/place.ts): a
//      writer cannot store a method the vocabulary does not have, and the
//      vocabulary cannot grow on one side only.

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { PLACE_METHODS } from "@/lib/domain/place";

/** table → [id column, method column]. */
const PLACE_TABLES: ReadonlyArray<readonly [string, string, string]> = [
  ["pets", "locality_id", "place_method"],
  ["cases", "locality_id", "place_method"],
  ["welfare_reports", "locality_id", "place_method"],
  ["organizations", "locality_id", "place_method"],
  ["organization_coverage", "locality_id", "place_method"],
  ["service_offerings", "locality_id", "place_method"],
  ["govt_business_rules", "locality_id", "place_method"],
  ["alert_subscriptions", "locality_id", "place_method"],
  ["alert_firings", "locality_id", "place_method"],
  ["foster_volunteers", "locality_id", "place_method"],
  ["approval_requests", "locality_id", "place_method"],
  ["custody_disputes", "locality_id", "place_method"],
  ["event_notification_outbox", "target_locality_id", "target_place_method"],
];

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    select a.attname as name
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table}
       and a.attnum > 0 and not a.attisdropped
  `)) as unknown as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("every place table can say which row and how", () => {
  it.each(PLACE_TABLES)("%s has %s and %s", async (table, idCol, methodCol) => {
    const cols = await columnsOf(table);
    expect(cols.has(idCol), `${table}.${idCol}`).toBe(true);
    expect(cols.has(methodCol), `${table}.${methodCol}`).toBe(true);
  });

  it("welfare_reports keeps the place as entered, for denuncias that write no event", async () => {
    expect((await columnsOf("welfare_reports")).has("place_entered")).toBe(true);
  });
});

// Security review of stage B: re-adding fourteen FKs validated inline scans
// every place table while holding its lock. The FK is added NOT VALID (no scan,
// brief lock) and validated in a separate statement.
describe("0248 adds its foreign keys without a validating scan under lock", () => {
  const source = readFileSync("db/migrations/0248_place_columns.sql", "utf8");

  it("every FK it adds is NOT VALID, and each is validated separately", () => {
    const adds = source.match(/ADD CONSTRAINT %I FOREIGN KEY[^;]*/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/NOT VALID/);
    expect(source).toMatch(/VALIDATE CONSTRAINT %I/);
  });

  it("the live constraints end validated", async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as unvalidated
        from pg_catalog.pg_constraint c
       where c.contype = 'f'
         and c.confrelid = 'public.ar_localities'::regclass
         and not c.convalidated
    `)) as unknown as Array<{ unvalidated: number }>;
    expect(rows[0]?.unvalidated).toBe(0);
  });
});

describe("no catalogue row can vanish from under a place", () => {
  it("every foreign key into ar_localities is ON DELETE RESTRICT", async () => {
    const rows = (await db.execute(sql`
      select c.conrelid::regclass::text as tbl, c.confdeltype as on_delete
        from pg_catalog.pg_constraint c
       where c.contype = 'f'
         and c.confrelid = 'public.ar_localities'::regclass
       order by 1
    `)) as unknown as Array<{ tbl: string; on_delete: string }>;
    // Non-vacuous: the four pre-existing FKs and the ten new ones.
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.filter((r) => r.on_delete !== "r")).toEqual([]);
  });
});

describe("the method vocabulary is one list", () => {
  it.each(PLACE_TABLES)("%s refuses a method the vocabulary lacks", async (table, _id, col) => {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(c.oid) as def
        from pg_catalog.pg_constraint c
       where c.contype = 'c'
         and c.conrelid = ${`public.${table}`}::regclass
         and c.conname = ${`${table}_${col}_known`}
    `)) as unknown as Array<{ def: string }>;
    expect(rows).toHaveLength(1);
    const listed = [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(listed).toEqual([...PLACE_METHODS]);
  });

  it("nearest-centroid is not a method: the database refuses it", async () => {
    let error: unknown = null;
    await db
      .transaction(async (tx) => {
        const touched = (await tx.execute(sql`
          update public.pets set place_method = 'nearest_centroid'
           where id = (select id from public.pets limit 1)
          returning id
        `)) as unknown as unknown[];
        // Only reached if the CHECK let it through; the rollback keeps the
        // row either way, and an empty table would prove nothing.
        expect(touched).toHaveLength(1);
        tx.rollback();
      })
      .catch((e: unknown) => {
        error = e;
      });
    expect(constraintOf(error)).toBe("pets_place_method_known");
  });
});

/** drizzle wraps the driver error ("Failed query: …"); the name is on `.cause`. */
function constraintOf(e: unknown): string | null {
  let cur = e as { constraint_name?: string; cause?: unknown } | null;
  while (cur) {
    if (cur.constraint_name) return cur.constraint_name;
    cur = (cur.cause as typeof cur) ?? null;
  }
  return null;
}
