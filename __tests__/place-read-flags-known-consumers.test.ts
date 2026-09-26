// Fence: the per-consumer read-path flags (localidades-por-id D1, 0257).
//
// One closed list of consumers, in three places that must agree: the CHECK on
// public.place_read_flags, the rows seeded in it, and PLACE_READ_CONSUMERS in
// lib/place/flags.ts. Every consumer is SEEDED on the name path — no consumer
// reaches the id path by default; a flip is an operator act after the parity
// sweep. And whatever the table says that is not a known mode, the reader
// answers 'name', the only safe fallback.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

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
});
