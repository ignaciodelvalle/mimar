// Transactions on a pool with pipelining off (2026-10, engram
// infra/postgres-pipelining-supavisor-hang).
//
// `db` runs with `max_pipeline: 0` so no query is ever written onto a busy
// connection (a pipelined zero-row query hangs forever through Supavisor's
// transaction pooler). Upstream postgres.js 3.4.9 cannot run `.begin()` with
// that setting: execute() only called begin's `onexecute` hook, the one that
// reserves the connection for the transaction, when the pipeline condition
// held. With max_pipeline 0 it never held, so BEGIN came back as
// UNSAFE_TRANSACTION, or as a TypeError with `max: 1`.
// patches/postgres.patch runs the hook unconditionally. Every test here
// fails on an unpatched install.
//
// What "works" has to mean, beyond "did not throw":
//   - statements issued concurrently inside the transaction (a Promise.all) all
//     run in THAT transaction: they see one now(), which Postgres pins per
//     transaction;
//   - a query issued on the pool while the transaction is open never runs
//     inside it, even when the pool has one connection (the reserved connection
//     must not be handed out);
//   - a throw rolls back.
//
// Reads only, plus a temp table that dies with its session. Nothing persists.

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/db";

const NO_PIPELINING = { max_pipeline: 0 } as unknown as postgres.Options<
  Record<string, postgres.PostgresType>
>;

const clients: postgres.Sql[] = [];
function client(max: number): postgres.Sql {
  const c = postgres(process.env.DATABASE_URL as string, {
    ...NO_PIPELINING,
    max,
    prepare: false,
    onnotice: () => {},
  });
  clients.push(c);
  return c;
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
});

type NowRow = { t: Date };
function iso(rows: readonly NowRow[]): string {
  return new Date(rows[0].t).toISOString();
}

describe("the app pool (db) runs transactions with max_pipeline 0", () => {
  it("runs a Promise.all of queries inside db.transaction, all in one transaction", async () => {
    const result = await db.transaction(async (tx) => {
      const [a, b, empty, c] = await Promise.all([
        tx.execute<NowRow>(sql`select now() as t`),
        tx.execute<NowRow>(sql`select pg_sleep(0.05), now() as t`),
        tx.execute(sql`select 1 as one where false`),
        tx.execute<NowRow>(sql`select now() as t`),
      ]);
      return { a: iso(a), b: iso(b), c: iso(c), emptyCount: empty.length };
    });
    expect(result.emptyCount).toBe(0);
    expect(result.b).toBe(result.a);
    expect(result.c).toBe(result.a);
  });

  it("rolls back on throw and stays usable afterwards", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(rows[0].ok).toBe(1);
  });

  it("runs nested savepoints (tx.transaction) inside db.transaction, undoing only the failed one", async () => {
    const kept = await db.transaction(async (tx) => {
      // Temp table, dropped at COMMIT: nothing outlives the test.
      await tx.execute(sql`create temp table no_pipeline_sp (x int) on commit drop`);
      await tx.execute(sql`insert into no_pipeline_sp values (1)`);
      await expect(
        tx.transaction(async (inner) => {
          await inner.execute(sql`insert into no_pipeline_sp values (2)`);
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
      await tx.transaction(async (inner) => {
        await Promise.all([
          inner.execute(sql`insert into no_pipeline_sp values (3)`),
          inner.execute(sql`select 1 where false`),
        ]);
      });
      const rows = await tx.execute<{ x: number }>(sql`select x from no_pipeline_sp order by x`);
      return rows.map((r) => r.x);
    });
    expect(kept).toEqual([1, 3]);
  });

  it("runs several transactions and plain queries concurrently on the shared pool", async () => {
    const work = Array.from({ length: 6 }, (_, i) =>
      i % 2 === 0
        ? db.transaction(async (tx) => {
            const [x, y] = await Promise.all([
              tx.execute<NowRow>(sql`select now() as t`),
              tx.execute<NowRow>(sql`select now() as t`),
            ]);
            return iso(x) === iso(y);
          })
        : db.execute(sql`select 1 where false`).then((r) => r.length === 0),
    );
    expect(await Promise.all(work)).toEqual([true, true, true, true, true, true]);
  });
});

describe("raw postgres.js .begin() with max_pipeline 0", () => {
  it("works with max: 1, the configuration upstream crashes with a TypeError", async () => {
    const one = client(1);
    const [a, b] = await one.begin((tx) => [
      tx<NowRow[]>`select pg_sleep(0.05), now() as t`,
      tx<NowRow[]>`select now() as t`,
    ]);
    expect(iso(b)).toBe(iso(a));
  });

  it("works with max: 3, the configuration upstream fails with UNSAFE_TRANSACTION", async () => {
    const three = client(3);
    const rows = await three.begin(async (tx) => {
      const [a, empty, b] = await Promise.all([
        tx<NowRow[]>`select now() as t`,
        tx`select 1 where false`,
        tx<NowRow[]>`select now() as t`,
      ]);
      return { a: iso(a), b: iso(b), empty: empty.length };
    });
    expect(rows.empty).toBe(0);
    expect(rows.b).toBe(rows.a);
  });

  it("never hands the reserved connection to a pool query (max: 1)", async () => {
    const one = client(1);
    let outside: Promise<NowRow[]> | undefined;
    const inside = await one.begin(async (tx) => {
      const first = await tx<NowRow[]>`select now() as t`;
      // Issued on the POOL while the transaction holds its only connection:
      // it must wait for COMMIT, not run inside the transaction.
      outside = one<NowRow[]>`select now() as t`;
      await tx`select pg_sleep(0.1)`;
      return iso(first);
    });
    expect(outside).toBeDefined();
    const after = iso(await (outside as Promise<NowRow[]>));
    expect(after).not.toBe(inside);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(inside).getTime());
  });

  it("rolls back on throw (max: 1)", async () => {
    const one = client(1);
    await expect(
      one.begin(async (tx) => {
        await tx`create temp table no_pipeline_probe (x int) on commit preserve rows`;
        await tx`insert into no_pipeline_probe values (1)`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Same single connection: had the transaction committed, the temp table
    // would still exist for this session.
    const [{ exists }] = await one<{ exists: boolean }[]>`
      select to_regclass('pg_temp.no_pipeline_probe') is not null as exists`;
    expect(exists).toBe(false);
  });
});
