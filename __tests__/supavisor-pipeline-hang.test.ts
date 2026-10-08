// The postgres.js pipelining hang, against a real Supavisor transaction pooler.
// OPT-IN: skipped unless SUPAVISOR_TRANSACTION_URL is set (engram
// infra/postgres-pipelining-supavisor-hang).
//
// postgres.js writes a query onto a connection that is still waiting for an
// earlier answer (pipelining). Through Supavisor in TRANSACTION mode, a
// pipelined query that returns zero rows can lose its answer: the promise
// never settles. Direct Postgres and the session pooler do not do this. The
// app pools therefore run with `max_pipeline: 0` (db/index.ts), which needs
// patches/postgres.patch for transactions to work at all.
//
// The local Supabase stack runs without its pooler, and enabling it means
// restarting the shared stack. A sidecar Supavisor on the stack's Docker
// network does not, which is how this was measured on 2026-10-06
// (supavisor 2.7.4, the CLI's own image):
//
//   10-query mixed fan-out, max 3, 20 trials:
//     default pipelining                                 16/20 and 17/20 hung
//     max_pipeline 0                                     0/20 hung (twice)
//     max_pipeline 0 + begin() with a Promise.all inside 0/20 hung (patched)
//     default pipelining, direct Postgres (control)      0/20 hung
//   this file, 10 trials per test:
//     production profile with pipelining put back        10/10 hung, both tests
//     production profile as committed                    0/10 hung, both tests
//
// The two-query shape that hung staging (one slow query, one empty one, max 1)
// did NOT hang on this local Supavisor; the wider fan-out did.
//
// To run it: dim-interno:docs/ops/supavisor-repro.md has the exact tenant
// script, the two docker commands (Supavisor plus its own metadata Postgres,
// neither touching the shared stack or its schema), the URL to export as
// SUPAVISOR_TRANSACTION_URL, and the cleanup. Wait for any gate on the shared
// database first: the test opens real connections through the sidecar.

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { oltpPoolOptions } from "@/db";
import { postgresTlsOption } from "@/db/tls";

const URL = process.env.SUPAVISOR_TRANSACTION_URL;
const TRIALS = 10;
const HANG_MS = 5_000;

type Options = postgres.Options<Record<string, postgres.PostgresType>>;

/** Twenty concurrent queries, half of them empty: wider than the production
 * pool (max 5), so a pipelining client must stack queries on busy connections. */
function fanOut(sql: postgres.Sql | postgres.TransactionSql): Promise<unknown> {
  return Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      i % 2 ? sql`select pg_sleep(0.1)` : sql`select ${i}::int as x where false`,
    ),
  );
}

/** Runs `work` on a fresh client `TRIALS` times; returns how many hung. */
async function countHangs(
  options: Options,
  work: (sql: postgres.Sql) => Promise<unknown>,
): Promise<number> {
  let hangs = 0;
  for (let t = 0; t < TRIALS; t++) {
    const sql = postgres(URL as string, {
      ...options,
      onnotice: () => {},
      ssl: postgresTlsOption(URL as string),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const verdict = await Promise.race([
      work(sql).then(() => "ok" as const),
      new Promise<"hang">((resolve) => {
        timer = setTimeout(() => resolve("hang"), HANG_MS);
      }),
    ]);
    clearTimeout(timer);
    if (verdict === "hang") hangs++;
    // A hung connection never drains; end() would wait for it forever.
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
  return hangs;
}

describe.skipIf(!URL)("Supavisor transaction pooler: pipelining hang (opt-in)", () => {
  it(
    "CONTROL: default pipelining hangs here, so the other assertions mean something",
    async () => {
      const hangs = await countHangs({ max: 3, prepare: false } as Options, fanOut);
      // Measured 16-17 of 20. Zero of ten means this pooler does not reproduce
      // the defect, and a green fix below would prove nothing.
      expect(hangs).toBeGreaterThan(0);
    },
    TRIALS * HANG_MS + 30_000,
  );

  it(
    "the production OLTP pool profile never hangs on the same fan-out",
    async () => {
      expect(await countHangs(oltpPoolOptions(false) as Options, fanOut)).toBe(0);
    },
    TRIALS * HANG_MS + 30_000,
  );

  it(
    "nor with transactions running Promise.all inside, beside plain queries",
    async () => {
      const hangs = await countHangs(oltpPoolOptions(false) as Options, (sql) =>
        Promise.all([sql.begin((tx) => fanOut(tx)), fanOut(sql), sql.begin((tx) => fanOut(tx))]),
      );
      expect(hangs).toBe(0);
    },
    TRIALS * HANG_MS + 30_000,
  );
});
