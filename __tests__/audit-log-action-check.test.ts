// @vitest-environment node
//
// audit_log.action ↔ AUDIT_LOG_ACTIONS parity — migration 0184.
//
// `action` was a bare `text` column whose 102-value catalog existed only in
// TypeScript. Every writer outside a plain drizzle object literal — the
// append-only triggers, the subject-rights RPCs, the `as typeof
// auditLog.$inferInsert` cast in src/modules/transfers/actions.ts — could mint
// an action nobody had declared, and one did: `scan_event_purged` (migration
// 0104's scan-retention trigger) was absent from the catalog for months with
// 160 rows in the local database.
//
// Migration 0184 projects the catalog into a DB CHECK. This file is what keeps
// the projection honest IN BOTH DIRECTIONS: widen the TypeScript list without a
// migration, or widen the constraint without the TypeScript list, and the set
// comparison below goes red naming the difference.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { AUDIT_LOG_ACTIONS, db } from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";

const CONSTRAINT = "audit_log_action_valid";

/** The CHECK's definition text, straight from the catalog. */
async function constraintDefinition(): Promise<string | null> {
  const rows = (await db.execute(sql`
    select pg_get_constraintdef(c.oid) as def
    from   pg_constraint c
    join   pg_class t on t.oid = c.conrelid
    where  t.relname = 'audit_log' and c.conname = ${CONSTRAINT}
  `)) as Array<{ def: string }>;
  return rows[0]?.def ?? null;
}

/** Every single-quoted literal in the constraint definition. */
function literalsIn(def: string): string[] {
  return [...def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"));
}

describe("audit_log.action CHECK (migration 0184)", () => {
  it("exists and is VALIDATED (not left NOT VALID)", async () => {
    const rows = (await db.execute(sql`
      select c.convalidated
      from   pg_constraint c
      join   pg_class t on t.oid = c.conrelid
      where  t.relname = 'audit_log' and c.conname = ${CONSTRAINT}
    `)) as Array<{ convalidated: boolean }>;

    expect(rows).toHaveLength(1);
    // A NOT VALID constraint tolerates the pre-existing rows it claims to
    // forbid — the exact "ratchet that stopped ratcheting" shape.
    expect(rows[0].convalidated).toBe(true);
  });

  it("names EXACTLY the actions in AUDIT_LOG_ACTIONS", async () => {
    const def = await constraintDefinition();
    expect(def).not.toBeNull();

    const inDb = new Set(literalsIn(def as string));
    const inTs = new Set<string>(AUDIT_LOG_ACTIONS);

    const missingFromDb = [...inTs].filter((a) => !inDb.has(a)).sort();
    const missingFromTs = [...inDb].filter((a) => !inTs.has(a)).sort();

    expect({ missingFromDb, missingFromTs }).toEqual({ missingFromDb: [], missingFromTs: [] });
  });

  it("has no duplicate entries in the TypeScript catalog", () => {
    const list = [...AUDIT_LOG_ACTIONS];
    const dupes = [...new Set(list.filter((a, i) => list.indexOf(a) !== i))];
    expect(dupes).toEqual([]);
  });

  it("rejects an action outside the catalog", async () => {
    await expectDbError(
      db.execute(sql`
        insert into public.audit_log (action, payload)
        values ('not_a_declared_action_0184', '{}'::jsonb)
      `),
      { code: "23514", constraint: CONSTRAINT },
    );
  });

  it("still accepts the trigger-written action that was missing from the catalog", async () => {
    // scan_event_purged is written by enforce_pet_events_append_only, in plain
    // SQL, with no TypeScript in the path. If a future catalog cleanup drops it
    // because "nothing in the app writes it", the scan-retention purge starts
    // failing in production — this is the pin that says why it must stay.
    expect(AUDIT_LOG_ACTIONS).toContain("scan_event_purged");
  });
});
