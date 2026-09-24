// Live-catalog fence for the objects staging lost by hand-patching
// (migration 0239_staging_schema_repair.sql).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A read-only audit on 2026-09-22 found staging's ledger claiming every
// migration through 0238 while the live schema was missing whole objects those
// migrations create: the `ref` schema (0060), two triggers (0033), the
// institutional no-pets trigger (0015, with the pre-0015 admin-only one still
// wired) and the hide-from-subject guard on the owner read policy of
// `pet_events` (0115, rewritten by 0137). Two of those are security controls.
// 0239 put them back and asserts them in its own post-condition block — but
// that block runs once, at apply time. This file asks the local catalog on
// every run, so none of the five can silently disappear HERE either (a
// hand-edited bootstrap step, a migration that drops and forgets to recreate).
//
// It pins definitions, not just names: a trigger re-pointed at another
// function, or a policy that keeps its name and loses its guard (exactly what
// staging had), is red.
//
// NOT PINNED: the three `pet_events.*_code -> ref.*` foreign keys 0061 wrote.
// They are absent from every canonical build (drizzle-kit push creates the
// columns first and 0061's ADD COLUMN IF NOT EXISTS is then skipped whole), so
// pinning their presence would be red everywhere and pinning their absence
// would freeze a gap. See 0239's header.
//
// PRE-FLIGHT: local Supabase stack, fully migrated. Catalog reads only.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

// Seed row counts written by 0060. A floor, not an exact match: a later
// migration may add vocabulary (0060's own header anticipates the remaining
// 20 jurisdictions), and must not have to touch this file to do so.
const REF_SEED_FLOOR: ReadonlyArray<readonly [string, number]> = [
  ["tipo_evento_sanitario", 17],
  ["via_aplicacion", 6],
  ["jurisdiccion_sanitaria", 4],
  ["identification_kind_norma", 4],
];

// Exact `pg_get_triggerdef` output of a correctly migrated database.
const EXPECTED_TRIGGERS: Readonly<Record<string, string>> = {
  pet_events_case_id_immutable:
    "CREATE TRIGGER pet_events_case_id_immutable BEFORE UPDATE ON public.pet_events FOR EACH ROW EXECUTE FUNCTION check_pet_event_case_id_immutable()",
  cases_set_updated_at:
    "CREATE TRIGGER cases_set_updated_at BEFORE UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION cases_set_updated_at()",
  ownerships_institutional_no_pets:
    "CREATE TRIGGER ownerships_institutional_no_pets BEFORE INSERT OR UPDATE ON public.ownerships FOR EACH ROW EXECUTE FUNCTION enforce_institutional_no_pets()",
};

const OWNER_READ_POLICY = "Pet events readable by active owner";

type TriggerRow = { tgname: string; def: string; enabled: string };
type PolicyRow = { cmd: string; roles: string; permissive: string; qual: string | null };

describe("staging drift guards (0239)", () => {
  it("schema ref exists with its four SENASA vocabulary tables and their seed rows", async () => {
    const tables = (await db.execute(sql`
      select c.relname as relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ref' and c.relkind = 'r'
      order by 1
    `)) as unknown as Array<{ relname: string }>;
    expect(tables.map((t) => t.relname)).toEqual(
      expect.arrayContaining(REF_SEED_FLOOR.map(([name]) => name)),
    );

    for (const [name, floor] of REF_SEED_FLOOR) {
      const [row] = (await db.execute(
        sql`select count(*)::int as n from ${sql.identifier("ref")}.${sql.identifier(name)}`,
      )) as unknown as Array<{ n: number }>;
      expect(row?.n, `ref.${name} seed rows`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("the three triggers are wired, enabled, and point at the right functions", async () => {
    const rows = (await db.execute(sql`
      select t.tgname as tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as enabled
      from pg_trigger t
      where t.tgname in (
        'pet_events_case_id_immutable',
        'cases_set_updated_at',
        'ownerships_institutional_no_pets'
      )
      and not t.tgisinternal
    `)) as unknown as TriggerRow[];
    const byName = Object.fromEntries(rows.map((r) => [r.tgname, r]));

    for (const [name, def] of Object.entries(EXPECTED_TRIGGERS)) {
      expect(byName[name]?.def, `trigger ${name}`).toBe(def);
      expect(byName[name]?.enabled, `trigger ${name} must not be disabled`).not.toBe("D");
    }
  });

  it("the pre-0015 admin-only ownership trigger and its function are gone", async () => {
    const [row] = (await db.execute(sql`
      select
        (select count(*)::int from pg_trigger where tgname = 'ownerships_admin_no_pets') as triggers,
        (to_regprocedure('public.enforce_admin_no_pets()') is not null) as fn_exists
    `)) as unknown as Array<{ triggers: number; fn_exists: boolean }>;
    expect(row?.triggers).toBe(0);
    expect(row?.fn_exists).toBe(false);
  });

  it("the owner read policy on pet_events keeps the hide-from-subject-case guard", async () => {
    const rows = (await db.execute(sql`
      select cmd, roles::text as roles, permissive, qual
      from pg_policies
      where schemaname = 'public'
        and tablename = 'pet_events'
        and policyname = ${OWNER_READ_POLICY}
    `)) as unknown as PolicyRow[];
    expect(rows).toHaveLength(1);
    const [policy] = rows;
    expect(policy?.cmd).toBe("SELECT");
    expect(policy?.roles).toBe("{authenticated}");
    expect(policy?.permissive).toBe("PERMISSIVE");

    // The owner branch must be AND-ed with the guard, not OR-ed next to it:
    // staging had can_read_case in an OR branch and no guard at all, so the
    // presence of can_read_case alone proves nothing.
    const qual = policy?.qual ?? "";
    expect(qual).toContain("o.ended_at IS NULL");
    expect(qual).toContain(
      "AND ((case_id IS NULL) OR (NOT is_hidden_from_subject_case(case_id)) OR can_read_case(case_id, ( SELECT auth.uid() AS uid)))",
    );
  });
});
