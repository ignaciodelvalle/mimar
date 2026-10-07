// RLS — caller roles cannot TRUNCATE (migration 0284).
//
// WHAT THIS DEFENDS
// -----------------
// TRUNCATE is not subject to row level security and fires no row trigger.
// Supabase's default privileges and deploy-provision's old `grant all on all
// tables` gave anon and authenticated TRUNCATE on every public table (55 of 65
// on a fresh local stack), so a session under either role could empty a table
// with no trace. 0284 revokes it everywhere and from the default privileges.
//
// SHAPE: the catalog half asks has_table_privilege over EVERY public table;
// the behavioural half runs a real TRUNCATE as each caller role and expects
// 42501. Every TRUNCATE runs inside a transaction that is ALWAYS rolled back
// (a sentinel error after the statement), so a regression fails the test
// without emptying the shared local database.
//
// PRE-FLIGHT: local Supabase stack with 0284 applied, .env.local loaded.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";

type Role = "anon" | "authenticated";
const ROLES: readonly Role[] = ["anon", "authenticated"];

/** Thrown after the statement so the transaction never commits. */
class Rollback extends Error {}

/**
 * Run `statement` as `role` inside a transaction that is always rolled back.
 * Returns the Postgres error code, or null when the statement succeeded.
 */
async function codeAs(
  role: Role,
  statement: ReturnType<typeof sql>,
  setup?: ReturnType<typeof sql>,
): Promise<string | null> {
  try {
    await db.transaction(async (tx) => {
      if (setup) await tx.execute(setup);
      const claims =
        role === "anon" ? { role } : { sub: "00000000-0000-4000-8000-000000000284", role };
      await tx.execute(
        sql`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`,
      );
      await tx.execute(
        role === "anon" ? sql`SET LOCAL ROLE anon` : sql`SET LOCAL ROLE authenticated`,
      );
      await tx.execute(statement);
      throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) return null;
    return pgErrorCode(err) ?? "unknown";
  }
  return null;
}

/** Tables a regression would hurt most: identity, custody, the scheduling surface. */
const PROBED_TABLES = [
  "pets",
  "profiles",
  "ownerships",
  "organization_memberships",
  "notifications",
  "appointments",
  "service_schedule_rules",
  "time_slots",
] as const;

describe("caller-role TRUNCATE — catalog (0284)", () => {
  it("no public table is truncatable by anon or authenticated", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relname::text AS table_name, r.role::text AS role
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r(role)
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND has_table_privilege(r.role, c.oid, 'TRUNCATE')
       ORDER BY 1, 2
    `)) as unknown as { table_name: string; role: string }[];
    expect(rows.map((r) => `${r.role}:${r.table_name}`)).toEqual([]);
  });

  it("the sweep is not vacuous: it judged the whole public schema", async () => {
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `)) as unknown as { n: number }[];
    expect(row.n).toBeGreaterThan(50);
  });
});

describe("caller-role TRUNCATE — behaviour (0284)", () => {
  for (const role of ROLES) {
    for (const table of PROBED_TABLES) {
      it(`${role} cannot TRUNCATE public.${table}`, async () => {
        expect(await codeAs(role, sql.raw(`TRUNCATE public.${table}`))).toBe("42501");
      });
    }
  }

  // The default-privilege half of 0284: a table created by the migration role
  // AFTER 0284 is born without TRUNCATE for the caller roles. The positive
  // control in the same transaction (a SELECT that succeeds) proves the 42501
  // is about TRUNCATE, not about a role that cannot see the table at all.
  const PROBE_DDL = sql`CREATE TABLE public._truncate_probe_0284 (x int)`;

  for (const role of ROLES) {
    it(`${role} reads a table created after 0284 but cannot TRUNCATE it`, async () => {
      expect(await codeAs(role, sql`SELECT x FROM public._truncate_probe_0284`, PROBE_DDL)).toBe(
        null,
      );
      expect(await codeAs(role, sql`TRUNCATE public._truncate_probe_0284`, PROBE_DDL)).toBe(
        "42501",
      );
    });
  }
});
