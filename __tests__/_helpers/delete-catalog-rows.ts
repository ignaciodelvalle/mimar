// Hard-delete catalogue FIXTURE rows in a test teardown, detaching whatever
// points at them first.
//
// Since migration 0248 every foreign key into `ar_localities` is ON DELETE
// RESTRICT: a place row must never lose its origin in silence (P2). A teardown
// that deletes a synthetic fixture row a test (or a projection trigger) made
// something point at would now fail. This does, for test fixtures only, what
// the old ON DELETE SET NULL did silently: each referencing row gets its
// locality id (and the method next to it) set to NULL, `event_places` rows —
// a rebuildable projection — are deleted, and only then the catalogue rows go.
// A `place_resolutions` row is append-only and cannot be detached: the helper
// refuses loudly rather than leave a half-cleaned catalogue.
//
// The referencing columns are read from pg_constraint, so a future FK into the
// catalogue is covered without editing this file.

import { type SQL, inArray, sql } from "drizzle-orm";

import { arLocalities, db } from "@/db";

type Reference = { tbl: string; col: string; method_col: string | null };

export async function deleteCatalogRows(where: SQL | undefined): Promise<number> {
  const rows = await db.select({ id: arLocalities.id }).from(arLocalities).where(where);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const refs = (await db.execute(sql`
    select c.conrelid::regclass::text as tbl, a.attname as col,
           (select m.attname from pg_catalog.pg_attribute m
             where m.attrelid = c.conrelid and not m.attisdropped
               and m.attname = replace(a.attname, 'locality_id', 'place_method')) as method_col
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.ar_localities'::regclass
  `)) as unknown as Reference[];

  for (const ref of refs) {
    const table = sql.raw(ref.tbl);
    const col = sql.identifier(ref.col);
    if (ref.tbl.endsWith("place_resolutions")) {
      const [held] = (await db.execute(
        sql`select count(*)::int as n from ${table} where ${col} in (${list})`,
      )) as unknown as Array<{ n: number }>;
      if ((held?.n ?? 0) > 0) {
        throw new Error("deleteCatalogRows: a place_resolutions row (append-only) names a fixture");
      }
      continue;
    }
    if (ref.tbl.endsWith("event_places")) {
      await db.execute(sql`delete from ${table} where ${col} in (${list})`);
      continue;
    }
    const setMethod = ref.method_col ? sql`, ${sql.identifier(ref.method_col)} = null` : sql``;
    await db.execute(sql`update ${table} set ${col} = null${setMethod} where ${col} in (${list})`);
  }

  await db.delete(arLocalities).where(inArray(arLocalities.id, ids));
  return ids.length;
}
