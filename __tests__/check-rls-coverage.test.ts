/**
 * Unit tests for the pure evaluators in scripts/check-rls-coverage.ts.
 *
 * Pure fixture tests — no database. The catalog-level assertions live in
 * __tests__/rls/coverage.test.ts, which runs against the real local Postgres;
 * these pin the DECISION RULES so a fence that once counted policies without
 * reading them cannot regress to that quietly.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_ADMIN_PREDICATES_IN_SOURCE,
  PUBLIC_ROLE_ALLOWLIST,
  type PolicyRoleRow,
  evaluateCoverage,
  evaluatePlatformAdminPredicates,
  evaluatePolicyRoles,
  findPlatformAdminPredicates,
  scanSourceSqlForAdminPredicates,
} from "@/scripts/check-rls-coverage";

function policy(overrides: Partial<PolicyRoleRow> = {}): PolicyRoleRow {
  return {
    table_name: "pets",
    policy_name: "pets select by owner",
    roles: ["authenticated"],
    cmd: "SELECT",
    ...overrides,
  };
}

describe("evaluatePolicyRoles", () => {
  it("flags a policy whose role set is the PUBLIC default", () => {
    // pg_policies renders a missing TO clause as exactly {public}.
    const { violations } = evaluatePolicyRoles([policy({ roles: ["public"] })]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ table_name: "pets", cmd: "SELECT" });
  });

  it("accepts an explicit authenticated-only policy", () => {
    expect(evaluatePolicyRoles([policy()]).violations).toEqual([]);
  });

  it("accepts an explicit anon policy — naming anon is a decision, defaulting to it is not", () => {
    const rows = [policy({ roles: ["anon", "authenticated"] }), policy({ roles: ["anon"] })];
    expect(evaluatePolicyRoles(rows).violations).toEqual([]);
  });

  it("does NOT treat a role set that merely CONTAINS public as the default", () => {
    // `TO public, authenticated` is redundant but written down; only the bare
    // single-element {public} is the "nobody said anything" shape.
    expect(
      evaluatePolicyRoles([policy({ roles: ["public", "authenticated"] })]).violations,
    ).toEqual([]);
  });

  it("respects the allowlist and reports it separately", () => {
    const key = "ar_localities:ar_localities select authenticated";
    try {
      PUBLIC_ROLE_ALLOWLIST[key] = "test fixture";
      const result = evaluatePolicyRoles([
        policy({
          table_name: "ar_localities",
          policy_name: "ar_localities select authenticated",
          roles: ["public"],
        }),
      ]);
      expect(result.violations).toEqual([]);
      expect(result.allowlisted).toEqual([key]);
    } finally {
      delete PUBLIC_ROLE_ALLOWLIST[key];
    }
  });

  it("ships with an EMPTY allowlist — every policy names its roles today", () => {
    expect(Object.keys(PUBLIC_ROLE_ALLOWLIST)).toEqual([]);
  });
});

describe("evaluateCoverage (unchanged contract — db:doctor shares it)", () => {
  it("flags a table with RLS disabled", () => {
    const { violations } = evaluateCoverage([
      { table_name: "pets", rls_enabled: false, policy_count: "3" },
    ]);
    expect(violations).toEqual([{ table_name: "pets", kind: "rls_disabled" }]);
  });

  it("flags an RLS-enabled table with zero policies and no allowlist entry", () => {
    const { violations } = evaluateCoverage([
      { table_name: "brand_new_table", rls_enabled: true, policy_count: "0" },
    ]);
    expect(violations).toEqual([{ table_name: "brand_new_table", kind: "no_policies" }]);
  });

  it("treats a documented deny-all table as allowlisted, not a violation", () => {
    const { violations, allowlisted } = evaluateCoverage([
      { table_name: "rate_limit_buckets", rls_enabled: true, policy_count: "0" },
    ]);
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual(["rate_limit_buckets"]);
  });
});

// ---------------------------------------------------------------------------
// Check 5 — platform-authority predicates (admin, migration 0215; govt,
// migration 0216) must exclude erased + deactivated profiles. These fixtures
// are the permanent proof the scan is not vacuous: each shape below was a real
// predicate in the repo on 2026-09-09, and the negative ones are what the
// catalog looked like BEFORE the fix for that role.
// ---------------------------------------------------------------------------

function violationsOf(sql: string, source = "fixture") {
  return evaluatePlatformAdminPredicates(findPlatformAdminPredicates(sql, source)).violations;
}

describe("findPlatformAdminPredicates / evaluatePlatformAdminPredicates", () => {
  it("flags the pre-0215 db/cases_rls.sql shape — deactivated_at without deleted_at, unaliased", () => {
    const sql = `
      if exists (
        select 1 from public.profiles
        where id = p_user_id and role = 'admin' and deactivated_at is null
      ) then return true; end if;`;
    const found = findPlatformAdminPredicates(sql, "cases");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ alias: null, hasDeactivatedAt: true, hasDeletedAt: false });
    expect(violationsOf(sql)).toHaveLength(1);
  });

  it("flags the pre-0215 db/rls.sql shape — neither marker, aliased", () => {
    const sql = `
      create policy "audit log visible to actor or admin" on public.audit_log for select to authenticated
      using (
        actor_user_id = auth.uid()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role = 'admin'
        )
      );`;
    const [v] = violationsOf(sql);
    expect(v).toMatchObject({ alias: "p", hasDeletedAt: false, hasDeactivatedAt: false });
  });

  it("accepts the 0215 shape — both markers in the same AND-group", () => {
    const sql = `
      using (
        actor_user_id = auth.uid()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
            and p.deactivated_at is null
            and p.deleted_at is null
        )
      );`;
    expect(findPlatformAdminPredicates(sql, "x")).toHaveLength(1);
    expect(violationsOf(sql)).toEqual([]);
  });

  it("reads the catalog's deparsed rendering (every comparison parenthesised, ::user_role casts)", () => {
    const clean = `((actor_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::user_role) AND (p.deactivated_at IS NULL) AND (p.deleted_at IS NULL)))))`;
    expect(violationsOf(clean)).toEqual([]);

    const pre0215 = `((actor_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'admin'::user_role) AND (p.deactivated_at IS NULL)))))`;
    expect(violationsOf(pre0215)).toHaveLength(1);
  });

  it("does NOT let a sibling govt branch lend its deleted_at to the admin branch", () => {
    // custody_disputes shape: admin OR govt, both on the same profiles alias.
    // The govt branch carries deleted_at here; the admin branch does not.
    const sql = `(EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL))
        OR ((p.role = 'govt'::user_role) AND (p.deactivated_at IS NULL) AND (p.deleted_at IS NULL))))))`;
    const [v] = violationsOf(sql);
    expect(v, "the govt branch's deleted_at was credited to the admin branch").toBeDefined();
    expect(v.hasDeletedAt).toBe(false);
  });

  it("credits a marker applied OUTSIDE the OR, at the query's own AND level", () => {
    const sql = `exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.deleted_at is null
        and p.deactivated_at is null
        and ((p.role = 'admin' and p.account_type = 'institutional') or (p.role = 'govt'))
    )`;
    expect(violationsOf(sql)).toEqual([]);
  });

  it("reads profiles through a JOIN (custody_dispute_parties / pet_service_dog shape) — and sees BOTH pre-fix branches", () => {
    // The catalog before 0215 AND 0216: the admin branch lacks deleted_at, the
    // govt branch lacks both markers. Two holes, two violations, each named by
    // its own role.
    const pre0215 = `(EXISTS ( SELECT 1
      FROM (custody_disputes cd JOIN profiles p ON ((p.id = ( SELECT auth.uid() AS uid))))
      WHERE ((cd.id = custody_dispute_parties.dispute_id) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)) OR ((p.role = 'govt'::user_role) AND (EXISTS ( SELECT 1 FROM govt_assignments g WHERE (g.user_id = p.id))))))))`;
    const violations = violationsOf(pre0215);
    expect(violations.map((v) => [v.role, v.hasDeletedAt, v.hasDeactivatedAt])).toEqual([
      ["admin", false, true],
      ["govt", false, false],
    ]);
  });

  // -------------------------------------------------------------------------
  // Govt (migration 0216). Same subject, second role: the govt branches 0215
  // copied verbatim carried the same hole, and the scanner must read them the
  // same way. Negative fixtures are the catalog BEFORE 0216.
  // -------------------------------------------------------------------------

  it("flags the pre-0216 pet_identifications govt policy — deactivated_at without deleted_at, aliased through a JOIN", () => {
    const pre0216 = `(EXISTS ( SELECT 1
      FROM (pets pt JOIN profiles p ON ((p.id = ( SELECT auth.uid() AS uid))))
      WHERE ((pt.id = pet_identifications.pet_id) AND (p.role = 'govt'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (EXISTS ( SELECT 1
        FROM govt_assignments ga
        WHERE ((ga.user_id = p.id) AND (ga.revoked_at IS NULL) AND (ga.jurisdiction_province = pt.jurisdiction_province) AND (ga.jurisdiction_locality = pt.jurisdiction_locality)))))))`;
    const [v] = violationsOf(pre0216);
    expect(v).toMatchObject({
      role: "govt",
      alias: "p",
      hasDeletedAt: false,
      hasDeactivatedAt: true,
    });
  });

  it("flags the pre-0216 db/cases_rls.sql govt branch — the source form, aliased, INNER JOIN", () => {
    const sql = `
      if exists (
        select 1
        from public.profiles p
        inner join public.govt_assignments ga on ga.user_id = p.id
        where p.id = p_user_id
          and p.role = 'govt'
          and p.deactivated_at is null
          and ga.revoked_at is null
      ) then return true; end if;`;
    const [v] = violationsOf(sql);
    expect(v).toMatchObject({ role: "govt", alias: "p", hasDeletedAt: false });
  });

  it("does NOT let a sibling admin branch lend its deleted_at to the govt branch", () => {
    // custody_disputes as 0215 left it: admin carries both markers, govt only
    // deactivated_at. The mirror image of the sibling test above.
    const sql = `(EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (p.deleted_at IS NULL))
        OR ((p.role = 'govt'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (EXISTS ( SELECT 1 FROM govt_assignments g WHERE (g.user_id = p.id))))))))`;
    const violations = violationsOf(sql);
    expect(
      violations,
      "the admin branch's deleted_at was credited to the govt branch",
    ).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      role: "govt",
      hasDeletedAt: false,
      hasDeactivatedAt: true,
    });
  });

  it("accepts the 0216 shape — govt branch with both markers next to an admin branch with both", () => {
    const sql = `(EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (p.deleted_at IS NULL))
        OR ((p.role = 'govt'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (p.deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM govt_assignments g WHERE (g.user_id = p.id))))))))`;
    const found = findPlatformAdminPredicates(sql, "x");
    expect(found.map((p) => p.role)).toEqual(["admin", "govt"]);
    expect(violationsOf(sql)).toEqual([]);
  });

  it("accepts the 0216 approval_requests shape — a profiles test ANDed with the assignment test", () => {
    const sql = `using (
      applicant_user_id = auth.uid()
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'admin' and p.deactivated_at is null and p.deleted_at is null
      )
      or (
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.role = 'govt'
            and p.deactivated_at is null
            and p.deleted_at is null
        )
        and exists (
          select 1 from public.govt_assignments g
          where g.user_id = auth.uid() and g.revoked_at is null
        )
      )
    );`;
    expect(findPlatformAdminPredicates(sql, "x").map((p) => p.role)).toEqual(["admin", "govt"]);
    expect(violationsOf(sql)).toEqual([]);
  });

  it("is BLIND to an authority grant that never names a role — the pre-0216 approval_requests govt branch", () => {
    // `exists (select 1 from govt_assignments g where g.user_id = auth.uid())`
    // reads no profile and tests no role, so there is nothing here for a
    // profile-marker scanner to find. That is a known limit, not a pass: 0216
    // closed it by putting a profiles test in front of the assignment test
    // (accepted above), and __tests__/rls/erased-admin-authority.test.ts
    // proves the behaviour. This fixture pins the limit so nobody reads an
    // empty result as coverage.
    const sql = `using (
      applicant_user_id = auth.uid()
      or exists (
        select 1 from public.govt_assignments g
        where g.user_id = auth.uid() and g.revoked_at is null
      )
    );`;
    expect(findPlatformAdminPredicates(sql, "x")).toEqual([]);
  });

  it("accepts role IN (...) and role = ANY(ARRAY[...]) (revocations bucket shapes)", () => {
    const source = `with check (
      bucket_id = 'revocations'
      and exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.account_type = 'institutional'
          and p.role in ('admin', 'govt')
          and p.deactivated_at is null
          and p.deleted_at is null
      )
    );`;
    expect(findPlatformAdminPredicates(source, "x")).toHaveLength(1);
    expect(violationsOf(source)).toEqual([]);

    const catalog = `((bucket_id = 'revocations'::text) AND (EXISTS ( SELECT 1
      FROM profiles p
      WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.account_type = 'institutional'::text) AND (p.role = ANY (ARRAY['admin'::user_role, 'govt'::user_role])) AND (p.deactivated_at IS NULL)))))`;
    expect(
      violationsOf(catalog),
      "ANY(ARRAY[...]) without deleted_at slipped through",
    ).toHaveLength(1);
  });

  it("ignores an ORGANIZATION admin role — organization_memberships has no erasure marker", () => {
    const sql = `using (
      exists (
        select 1 from public.organization_memberships om
        where om.user_id = auth.uid() and om.left_at is null and om.role = 'admin'
      )
    );`;
    expect(findPlatformAdminPredicates(sql, "x")).toEqual([]);
  });

  it("ignores a role test on ANOTHER alias even when profiles is in the same query", () => {
    const sql = `exists (
      select 1 from public.organization_memberships om
      join public.profiles p on p.id = om.user_id
      where om.role = 'admin' and p.deleted_at is null
    )`;
    expect(findPlatformAdminPredicates(sql, "x")).toEqual([]);
  });

  it("does not count a comment mentioning the marker as the marker", () => {
    const sql = `
      -- an erased profile (deleted_at is null is what we want here) is not an admin
      exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'admin' and p.deactivated_at is null
      )`;
    expect(violationsOf(sql)).toHaveLength(1);
  });

  it("is quiet on SQL with no admin test at all", () => {
    expect(
      findPlatformAdminPredicates(
        "insert into public.notifications (category) values ('admin');",
        "x",
      ),
    ).toEqual([]);
  });
});

describe("db/*.sql — every platform-authority predicate excludes erased + deactivated profiles", () => {
  const predicates = scanSourceSqlForAdminPredicates();

  it(`finds at least ${MIN_ADMIN_PREDICATES_IN_SOURCE} platform-authority tests (non-vacuity)`, () => {
    expect(
      predicates.length,
      `only ${predicates.length} found — the glob or the scanner is broken, not the SQL`,
    ).toBeGreaterThanOrEqual(MIN_ADMIN_PREDICATES_IN_SOURCE);
  });

  it("finds govt tests too — cases_rls.sql's govt branch and rls.sql's approval_requests (0216)", () => {
    const govt = predicates.filter((p) => p.role === "govt").map((p) => p.source);
    expect(govt).toEqual(expect.arrayContaining(["db/cases_rls.sql", "db/rls.sql"]));
  });

  it("has no predicate missing deleted_at or deactivated_at", () => {
    const { violations } = evaluatePlatformAdminPredicates(predicates);
    expect(
      violations.map((v) => `${v.source} (${v.role}): ${v.conjunct.slice(0, 120)}`),
      "a bootstrap file grants platform authority to an erased or deactivated profile — see migrations 0215 and 0216",
    ).toEqual([]);
  });
});
