// Fence: the per-consumer read-path flags (localidades-por-id D1, 0257).
//
// One closed list of consumers, in three places that must agree: the CHECK on
// public.place_read_flags, the rows seeded in it, and PLACE_READ_CONSUMERS in
// lib/place/flags.ts. 0257 seeded every consumer on the name path; 0276 made
// the id path the factory default for every consumer that has a reader
// (localidades CABA + Córdoba, direct cut, PO 2026-10-02), and left
// public_filters — which nothing reads — on 'name'. And whatever the table
// says that is not a known mode, the reader answers 'name', the only safe
// fallback.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import { PLACE_READ_CONSUMERS, readPlaceFlag } from "@/lib/place/flags";

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

const MIGRATION = readFileSync(
  join(process.cwd(), "db/migrations/0257_govt_scope_and_place_flags.sql"),
  "utf8",
);
const DEFAULT_ID = readFileSync(
  join(process.cwd(), "db/migrations/0276_place_read_flags_default_id.sql"),
  "utf8",
);

/** The factory mode of each consumer since 0276. */
const FACTORY: Readonly<Record<(typeof PLACE_READ_CONSUMERS)[number], "name" | "id">> = {
  scope: "id",
  routing: "id",
  rules: "id",
  coverage: "id",
  panorama: "id",
  public_filters: "name",
};

describe("place_read_flags", () => {
  it("the live table holds exactly the known consumers", async () => {
    const rows = (await db.execute(
      sql`select consumer from public.place_read_flags order by consumer`,
    )) as unknown as Array<{ consumer: string }>;
    expect(rows.map((r) => r.consumer)).toEqual([...PLACE_READ_CONSUMERS].sort());
  });

  it("the CHECK admits exactly the known consumers", async () => {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
       where conname = 'place_read_flags_consumer_check'
    `)) as unknown as Array<{ def: string }>;
    const listed = [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...PLACE_READ_CONSUMERS].sort());
  });

  it("the migration seeds every consumer on the name path, and only there", () => {
    const seeded = [...MIGRATION.matchAll(/\('([a-z_]+)', '([a-z]+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(seeded.map(([c]) => c).sort()).toEqual([...PLACE_READ_CONSUMERS].sort());
    for (const [consumer, mode] of seeded) expect(mode, consumer).toBe("name");
  });

  it("0276 seeds the factory modes: id for every consumer with a reader, public_filters name", () => {
    const seeded = Object.fromEntries(
      [...DEFAULT_ID.matchAll(/\('([a-z_]+)', '([a-z]+)'\)/g)].map((m) => [m[1], m[2]]),
    );
    expect(seeded).toEqual(FACTORY);
    // The UPDATE flips exactly the id consumers on an environment 0257 seeded.
    const updated = /WHERE consumer IN \(([^)]*)\)/.exec(DEFAULT_ID)?.[1] ?? "";
    expect([...updated.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      Object.entries(FACTORY)
        .filter(([, mode]) => mode === "id")
        .map(([c]) => c)
        .sort(),
    );
  });

  it("the live table serves the factory modes", async () => {
    const rows = (await db.execute(
      sql`select consumer, mode from public.place_read_flags`,
    )) as unknown as Array<{ consumer: keyof typeof FACTORY; mode: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.consumer, r.mode]))).toEqual(FACTORY);
  });

  it("the reader serves what the row says, and 'name' for a missing row", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(
        sql`update public.place_read_flags set mode = 'shadow' where consumer = 'routing'`,
      );
      expect(await readPlaceFlag("routing", tx)).toBe("shadow");
      await tx.execute(sql`delete from public.place_read_flags where consumer = 'rules'`);
      expect(await readPlaceFlag("rules", tx)).toBe("name");
    });
  });

  // Verify S7: a failed read inside a caller's transaction answers 'name' AND
  // leaves the transaction usable. Without its own savepoint the failed SELECT
  // aborts the caller's transaction and the next statement fails.
  it("a failed read on a transaction leaves that transaction usable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await inRolledBackTx(async (tx) => {
        // The table is unqualified in the query; an empty search path hides it.
        await tx.execute(sql`set local search_path = pg_catalog`);
        expect(await readPlaceFlag("scope", tx)).toBe("name");
        const [row] = (await tx.execute(sql`select 1 as ok`)) as unknown as Array<{ ok: number }>;
        expect(row?.ok).toBe(1);
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
