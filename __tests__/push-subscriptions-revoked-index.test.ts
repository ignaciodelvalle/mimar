// Armed fence for the revoked-row purge index on push_subscriptions
// (migration 0197, RN re-run HIGH follow-up 2026-08-22).
//
// THE SCAN THIS INDEX CLOSES
// ---------------------------------------------------------------------------
// lib/infra/data-lifecycle.ts `purgeRevokedPushSubscriptions` deletes
//   WHERE revoked_at IS NOT NULL AND revoked_at < <cutoff>
// in 500-row batches, draining under the cron's fair share. Until 0197 the
// table carried ONE index, `push_subscriptions_user_active_idx (user_id) WHERE
// revoked_at IS NULL` — the send path's, over exactly the rows the purge never
// touches. So every purge batch was a sequential scan over the whole table,
// and a scan whose cost grows with the table is the wrong shape for a job
// whose whole point is to keep the table from growing.
//
// WHY PARTIAL ON `revoked_at IS NOT NULL`
// ---------------------------------------------------------------------------
// Live rows (the common case, one per browser per user) never enter the
// index, so the registration and delivery paths pay nothing to maintain it;
// only a revocation writes an entry, and the purge removes it again within the
// TTL. The index's predicate is the purge's predicate, which is what makes the
// `revoked_at <` range read an index-range scan over the revoked population.
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project)
// ---------------------------------------------------------------------------
// The invariant IS an index definition. A mocked query has no planner, and a
// mocked test passes against a database that never ran 0197. Same reasoning
// as __tests__/rehome-shelter-custody-index.test.ts: read pg_indexes, by name
// AND by definition — "applied" is not the same as "closed".

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

const PURGE_INDEX = "push_subscriptions_revoked_at_idx";
/** 0152's send-path index; 0197 must leave it exactly as it was. */
const SEND_INDEX = "push_subscriptions_user_active_idx";

async function indexDefs(): Promise<Map<string, string>> {
  const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
  `);
  return new Map(rows.map((r) => [r.indexname, r.indexdef]));
}

describe("push_subscriptions — the revoked-row purge has an index to walk (0197)", () => {
  it("pg_indexes: the purge index exists, keyed on revoked_at, partial on the REVOKED population", async () => {
    const defs = await indexDefs();
    const def = defs.get(PURGE_INDEX);
    expect(def, `${PURGE_INDEX} is absent — migration 0197 did not run`).toBeDefined();
    // By definition, not by name: a same-named index with another predicate
    // would pass a name check and still leave the purge on a sequential scan.
    expect(def).toMatch(/USING btree \(revoked_at\)/);
    expect(def).toMatch(/WHERE \(revoked_at IS NOT NULL\)/);
    expect(def).not.toMatch(/UNIQUE/);
  });

  it("pg_indexes: the send-path index is untouched — live rows still resolve by user_id alone", async () => {
    const defs = await indexDefs();
    expect(defs.get(SEND_INDEX)).toMatch(/USING btree \(user_id\) WHERE \(revoked_at IS NULL\)/);
  });

  it("the purge's predicate is the index's predicate — change one, change both", () => {
    // A source pin on the consumer. If the purge ever stops filtering on
    // `revoked_at IS NOT NULL` (say, to prune live rows on last_used_at — which
    // the file's own constant explains must not happen), this index would be
    // pointing at the wrong population and the test names the coupling.
    const src = readFileSync(join(process.cwd(), "lib", "infra", "data-lifecycle.ts"), "utf8");
    const purgeAt = src.indexOf("export async function purgeRevokedPushSubscriptions(");
    expect(purgeAt, "purgeRevokedPushSubscriptions in data-lifecycle.ts").toBeGreaterThanOrEqual(0);
    const body = src.slice(purgeAt, src.indexOf("\n}\n", purgeAt));
    expect(body).toContain("WHERE revoked_at IS NOT NULL");
    expect(body).toMatch(/AND revoked_at < \$\{cutoff\}::timestamptz/);
  });
});
