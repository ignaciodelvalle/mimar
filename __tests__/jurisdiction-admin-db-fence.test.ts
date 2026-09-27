// DB-side fence for jurisdiction-admin (Phase 7) — read from the CATALOG.
//
// The app fence (scripts/check-admin-authority.ts) proves every writer asks
// the authority module. This is its database twin, over the live schema:
//
//   1. PLACE-SCOPED. Every function or policy that consults a jurisdiction
//      appointment (reads jurisdiction_admin_appointments or calls
//      jurisdiction_admin_province) also compares a PLACE — a province code,
//      the actor's province, or a place-deriving helper. An object that asks
//      "is this a jurisdiction admin?" and never "of where?" hands a province
//      admin the country. Comments are stripped from the body first: a comment
//      that names province_code proves nothing (red control below).
//      Floor: ≥ 5 objects — a broken query reads 0.
//   2. ARMED. The three guard triggers exist and are enabled.
//   3. PINNED. The audit guard's platform-only and delegated action lists are
//      exactly what the design says (govt_reactivated_by_admin platform-only),
//      and every name in them is a declared AUDIT_LOG_ACTIONS value.
//
// CATALOG ONLY. Nothing here calls a function as a denied role through SET
// ROLE — on this Postgres build that segfaults the backend (engram #3309);
// grants are asserted by has_function_privilege elsewhere
// (jurisdiction-admin-audit-visibility.test.tsx).

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { AUDIT_LOG_ACTIONS, db } from "@/db";

type DbObject = { kind: "function" | "policy"; name: string; body: string };

/** Strip SQL comments (line and block) so they never satisfy a rule. */
function stripSqlComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const CONSULTS_APPOINTMENT =
  /\bjurisdiction_admin_appointments\b|\bjurisdiction_admin_province\s*\(/;
const PLACE_TOKEN =
  /\bprovince_code\b|\bv_actor_province\b|\b\w*_place_codes\s*\(|\baudit_place_province\s*\(/g;

/**
 * Does an object that consults an appointment also compare a place? A place
 * token read once is at best an assignment nobody compares; a comparison
 * needs it at least twice (read, then compared — or both sides).
 */
function placeScoped(body: string): boolean {
  const code = stripSqlComments(body);
  return !CONSULTS_APPOINTMENT.test(code) || (code.match(PLACE_TOKEN) ?? []).length >= 2;
}

/** The names inside `c_<list> CONSTANT text[] := ARRAY[ ... ]` of a plpgsql body. */
function constantList(body: string, list: string): string[] {
  const code = stripSqlComments(body);
  const m = code.match(
    new RegExp(`\\b${list}\\s+CONSTANT\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`),
  );
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

/**
 * Objects that consult an appointment and do not compare a place BY DESIGN.
 * Key: regprocedure text. A stale entry (no such object) is an error.
 */
const NOT_PLACE_SCOPED: Readonly<Record<string, string>> = {
  "jurisdiction_admin_province()":
    "the RLS wrapper: returns jurisdiction_admin_province(auth.uid()) — the caller's province itself",
};

const MIN_OBJECTS = 5;

async function appointmentObjects(): Promise<DbObject[]> {
  const fns = (await db.execute(sql`
    select p.oid::regprocedure::text as name, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ~ 'jurisdiction_admin_appointments'
            or p.prosrc ~ 'jurisdiction_admin_province')`)) as unknown as Array<{
    name: string;
    body: string;
  }>;
  const policies = (await db.execute(sql`
    select c.relname || ': ' || pol.polname as name,
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as body
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'`)) as unknown as Array<{ name: string; body: string }>;
  return [
    ...fns.map((f) => ({ kind: "function" as const, ...f })),
    ...policies
      .filter((p) => CONSULTS_APPOINTMENT.test(p.body))
      .map((p) => ({ kind: "policy" as const, ...p })),
  ].filter((o) => CONSULTS_APPOINTMENT.test(stripSqlComments(o.body)));
}

async function guardBody(): Promise<string> {
  const [row] = (await db.execute(sql`
    select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'audit_log_province_guard'`)) as unknown as Array<{
    body: string;
  }>;
  return row?.body ?? "";
}

describe("the detector (red and green controls)", () => {
  it("a guard that asks for an appointment and compares a place is scoped", () => {
    expect(
      placeScoped(
        "select 1 from public.jurisdiction_admin_appointments a where a.province_code = NEW.province_code",
      ),
    ).toBe(true);
    expect(
      placeScoped(
        "v_actor_province := public.jurisdiction_admin_province(v_actor); if x <> v_actor_province",
      ),
    ).toBe(true);
  });

  it("RED: asking only WHETHER someone is an appointee is not scoped", () => {
    expect(
      placeScoped(
        "if exists (select 1 from public.jurisdiction_admin_appointments a where a.user_id = v and a.revoked_at is null) then return new; end if;",
      ),
    ).toBe(false);
  });

  it("RED: reading the actor's province and never comparing it is not scoped", () => {
    expect(
      placeScoped("v_actor_province := public.jurisdiction_admin_province(v_actor); return new;"),
    ).toBe(false);
  });

  it("RED: a comment that names province_code proves nothing", () => {
    expect(
      placeScoped(
        "-- compares province_code below\nif public.jurisdiction_admin_province(v) is not null then return new; end if; /* v_actor_province */",
      ),
    ).toBe(false);
  });

  it("reads a constant action list, and not one mentioned in a comment", () => {
    const body =
      "DECLARE\n  -- c_platform_only CONSTANT text[] := ARRAY['nope'];\n  c_platform_only CONSTANT text[] := ARRAY[\n 'b_act', -- why\n 'a_act'\n ];";
    expect(constantList(body, "c_platform_only")).toEqual(["a_act", "b_act"]);
    expect(constantList(body, "c_missing")).toEqual([]);
  });
});

describe("the live schema", () => {
  it("every object that consults an appointment compares a place (floor ≥ 5)", async () => {
    const objects = await appointmentObjects();
    expect(objects.length).toBeGreaterThanOrEqual(MIN_OBJECTS);
    const names = new Set(objects.map((o) => o.name));
    for (const exempt of Object.keys(NOT_PLACE_SCOPED)) {
      expect(names.has(exempt), `stale NOT_PLACE_SCOPED entry: ${exempt}`).toBe(true);
    }
    const unscoped = objects
      .filter((o) => !(o.name in NOT_PLACE_SCOPED) && !placeScoped(o.body))
      .map((o) => `${o.kind} ${o.name}`);
    expect(unscoped).toEqual([]);
    // The ones the design names are among them.
    for (const name of [
      "jurisdiction_admin_province(uuid)",
      "audit_log_province_guard()",
      "govt_assignments_jurisdiction_admin_guard()",
      "govt_business_rules_jurisdiction_admin_guard()",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    expect([...names].some((n) => n.startsWith("jurisdiction_admin_audit_trail("))).toBe(true);
  });

  it("the three guard triggers are attached and enabled", async () => {
    const rows = (await db.execute(sql`
      select c.relname as "table", t.tgname as name, t.tgenabled::text as enabled
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and t.tgname in ('audit_log_province_guard',
                          'govt_assignments_jurisdiction_admin_guard',
                          'govt_business_rules_jurisdiction_admin_guard')
       order by 2`)) as unknown as Array<{ table: string; name: string; enabled: string }>;
    expect(rows).toEqual([
      { table: "audit_log", name: "audit_log_province_guard", enabled: "O" },
      {
        table: "govt_assignments",
        name: "govt_assignments_jurisdiction_admin_guard",
        enabled: "O",
      },
      {
        table: "govt_business_rules",
        name: "govt_business_rules_jurisdiction_admin_guard",
        enabled: "O",
      },
    ]);
  });

  it("the audit guard's platform-only and delegated lists are pinned, and declared", async () => {
    const body = await guardBody();
    const platformOnly = constantList(body, "c_platform_only");
    const delegated = constantList(body, "c_delegated");
    expect(platformOnly).toEqual([
      "admin_deactivated_by_admin",
      "authority_unit_unconfirmed",
      "govt_assignment_unit_unconfirmed",
      "govt_reactivated_by_admin",
      "institutional_admin_created",
      "institutional_national_created",
      "jurisdiction_admin_appointed",
      "jurisdiction_admin_revoked",
      "mfa_factors_reset_by_admin",
      "operator_credentials_reset",
    ]);
    expect(delegated).toEqual([
      "authority_unit_confirmed",
      "authority_unit_created",
      "authority_unit_membership_moved",
      "authority_unit_membership_removed",
      "authority_unit_renamed",
      "govt_assignment_unit_confirmed",
      "govt_business_rule_created",
      "govt_business_rule_deleted",
      "govt_business_rule_updated",
      "govt_deactivated_by_admin",
      "govt_locality_assigned",
      "institutional_govt_created",
    ]);
    const declared = new Set<string>(AUDIT_LOG_ACTIONS);
    expect([...platformOnly, ...delegated].filter((a) => !declared.has(a))).toEqual([]);
    // No act is both.
    expect(platformOnly.filter((a) => delegated.includes(a))).toEqual([]);
  });
});
