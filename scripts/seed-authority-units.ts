#!/usr/bin/env tsx
/**
 * Seed the authority units from the catalogue, and report the partial grants
 * (localidades-por-id C2, PO decisions D1 + D2).
 *
 * WHAT IT WRITES. The plan is lib/place/authority-units-plan.ts: one
 * provincial unit per province, one municipio per Buenos Aires partido, ONE
 * ciudad unit over every CABA barrio, and elsewhere one unit per OFFICIAL LOCAL
 * GOVERNMENT, read from the committed reference
 * lib/reference/locality-gobierno-local.json (never from the network; see
 * scripts/generate-locality-gobierno-local.ts). Every unit is inserted as a
 * DRAFT under its seed key; every live catalogue row with no active municipal
 * membership is opened into its planned unit. Idempotent, and ADDITIVE ONLY:
 *   - a unit that already exists (by seed key) is left exactly as it is — an
 *     admin's rename or confirmation is never overwritten;
 *   - a locality that already has an active membership is left where it is,
 *     even when it is not the planned unit: an admin moved it (C4), and the
 *     seed is a proposal, never a correction. Those are counted as
 *     `keptElsewhere`.
 *   - a locality with no department where the unit comes from the department
 *     is NOT placed: it is printed for an admin, and
 *     __tests__/authority-unit-membership-integrity.test.ts stays red until
 *     someone places it. The seed never guesses (P1).
 *   - a locality the reference names no local government for gets no
 *     municipal unit: the provincial unit covers it (counted, not an error).
 *
 * SUPERSEDED DEPARTMENT UNITS. The first seed proposed a `departamento` unit
 * per department outside Buenos Aires; a department is not a government. A
 * `departamento` unit the plan no longer proposes is never deleted (units are
 * never deleted — trigger), but the memberships the SEED opened in it are
 * closed so the locality can move to its local government — only when:
 *   - the unit is still a draft (a person confirming it is a decision), and
 *   - the membership was opened by the seed (added_by null — an admin's
 *     placement stays), and
 *   - nothing points at the unit: no row of any table with a foreign key to
 *     authority_units (grants, rules, coverage, offerings, subscriptions, a
 *     child unit — read from the catalog, so a new table is covered).
 * A superseded unit that IS referenced keeps its memberships and is printed.
 *
 * WHAT IT NEVER WRITES. govt_assignments. The report lists every operator who
 * holds PART of a unit (8 of a partido's 9 localities), every whole-province
 * grant and every grant that cannot be mapped without guessing (a name with no
 * catalogue id). Widening access is a privacy act: a person decides it, this
 * script does not (D2).
 *
 * Runs in db:bootstrap after the catalogue import (the catalogue is imported
 * after migrations and is environment-specific, so this cannot be a
 * migration). Migration 0253 must be applied first.
 *
 *   pnpm seed:authority-units              write (local database)
 *   pnpm seed:authority-units --dry-run    run it in a transaction that is rolled back
 *   pnpm seed:authority-units --allow-remote   required for a non-local host
 */

import "./_load-env";

import { TransactionRollbackError, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  type AuthorityUnitPlan,
  type CatalogueLocality,
  type GrantCoverageReport,
  type GrantForReport,
  planAuthorityUnits,
  reportGrantCoverage,
} from "@/lib/place/authority-units-plan";
import { OFFICIAL_LOCAL_GOVERNMENTS } from "@/lib/place/local-governments";

type Executor = Pick<typeof db, "execute">;

/** Every live catalogue row, as the plan reads it. */
export async function loadCatalogue(tx: Executor): Promise<CatalogueLocality[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, province_code, locality_name, department_code, department_name,
           source, indec_id
      from public.ar_localities
     where removed_at is null
  `)) as unknown as Array<{
    id: string;
    province_code: string;
    locality_name: string;
    department_code: string | null;
    department_name: string | null;
    source: string;
    indec_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    provinceCode: r.province_code,
    localityName: r.locality_name,
    departmentCode: r.department_code,
    departmentName: r.department_name,
    source: r.source,
    indecId: r.indec_id,
  }));
}

/** The seed's plan for today's catalogue and the committed reference. */
export async function planFromDatabase(tx: Executor): Promise<AuthorityUnitPlan> {
  return planAuthorityUnits(await loadCatalogue(tx), OFFICIAL_LOCAL_GOVERNMENTS);
}

/** A superseded department unit something points at: its memberships stay. */
export type ReferencedSupersededUnit = {
  unitId: string;
  seedKey: string;
  name: string;
  provinceCode: string;
  /** "table.column" of every reference found. */
  referencedBy: string[];
  membershipsKept: number;
};

export type SeedResult = {
  unitsCreated: number;
  membershipsOpened: number;
  /** Seed-opened memberships in superseded department units, closed. */
  membershipsClosed: number;
  /** Planned localities an admin placed in another unit: left there. */
  keptElsewhere: number;
  referencedSuperseded: ReferencedSupersededUnit[];
};

/** Every unit id some row of another table (or a child unit) points at. */
async function referencedUnits(tx: Executor): Promise<Map<string, string[]>> {
  const fks = (await tx.execute(sql`
    select n.nspname as nsp, r.relname as rel, a.attname as col
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.confrelid = 'public.authority_units'::regclass
       and c.conrelid <> 'public.authority_unit_localities'::regclass
     order by 1, 2, 3
  `)) as unknown as Array<{ nsp: string; rel: string; col: string }>;
  const refs = new Map<string, string[]>();
  for (const fk of fks) {
    // Identifiers come from the catalog, never from input; quoted anyway.
    const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
    const tbl = `${quote(fk.nsp)}.${quote(fk.rel)}`;
    const col = quote(fk.col);
    const rows = (await tx.execute(
      sql.raw(`select distinct ${col}::text as id from ${tbl} where ${col} is not null`),
    )) as unknown as Array<{ id: string }>;
    for (const r of rows) {
      const list = refs.get(r.id) ?? [];
      list.push(`${fk.rel}.${fk.col}`);
      refs.set(r.id, list);
    }
  }
  return refs;
}

/**
 * Close the seed-opened memberships of the `departamento` units the plan no
 * longer proposes. See the header for the three conditions.
 */
async function closeSupersededDepartmentMemberships(
  tx: Executor,
  plan: AuthorityUnitPlan,
): Promise<{ closed: number; referenced: ReferencedSupersededUnit[] }> {
  const planned = JSON.stringify(plan.units.map((u) => u.seedKey));
  const superseded = (await tx.execute(sql`
    select u.id::text as id, u.seed_key, u.name, u.province_code,
           count(m.id)::int as members
      from public.authority_units u
      join public.authority_unit_localities m
        on m.unit_id = u.id and m.valid_to is null and m.added_by is null
     where u.kind = 'departamento'
       and u.status = 'draft'
       and u.seed_key like 'departamento:%'
       and not (u.seed_key = any (select jsonb_array_elements_text(${planned}::jsonb)))
     group by u.id
     order by u.seed_key
  `)) as unknown as Array<{
    id: string;
    seed_key: string;
    name: string;
    province_code: string;
    members: number;
  }>;
  if (superseded.length === 0) return { closed: 0, referenced: [] };

  const refs = await referencedUnits(tx);
  const referenced: ReferencedSupersededUnit[] = [];
  const free: string[] = [];
  for (const u of superseded) {
    const by = refs.get(u.id);
    if (by) {
      referenced.push({
        unitId: u.id,
        seedKey: u.seed_key,
        name: u.name,
        provinceCode: u.province_code,
        referencedBy: [...new Set(by)].sort(),
        membershipsKept: u.members,
      });
    } else {
      free.push(u.id);
    }
  }
  if (free.length === 0) return { closed: 0, referenced };
  const closed = (await tx.execute(sql`
    update public.authority_unit_localities m
       set valid_to = now()
     where m.valid_to is null
       and m.added_by is null
       and m.unit_id = any (select jsonb_array_elements_text(${JSON.stringify(free)}::jsonb)::uuid)
    returning m.id
  `)) as unknown as unknown[];
  return { closed: closed.length, referenced };
}

/** Write the plan, additively. See the header for what it never overwrites. */
export async function applyAuthorityUnitPlan(
  tx: Executor,
  plan: AuthorityUnitPlan,
): Promise<SeedResult> {
  const units = plan.units.map((u) => ({
    seed_key: u.seedKey,
    kind: u.kind,
    level: u.level,
    province_code: u.provinceCode,
    name: u.name,
    indec_department_code: u.indecDepartmentCode,
  }));
  const unitsJson = JSON.stringify(units);

  // Provincial units first: the others hang from them. Conflicts of any kind
  // (seed key, or a hand-made provincia of the same province) are left alone.
  const provincial = (await tx.execute(sql`
    insert into public.authority_units (seed_key, kind, level, province_code, name, indec_department_code)
    select x.seed_key, x.kind, x.level, x.province_code, x.name, x.indec_department_code
      from jsonb_to_recordset(${unitsJson}::jsonb)
        as x(seed_key text, kind text, level text, province_code text, name text, indec_department_code text)
     where x.level = 'provincial'
    on conflict do nothing
    returning id
  `)) as unknown as unknown[];
  const others = (await tx.execute(sql`
    insert into public.authority_units
      (seed_key, kind, level, province_code, name, indec_department_code, parent_unit_id)
    select x.seed_key, x.kind, x.level, x.province_code, x.name, x.indec_department_code,
           (select p.id from public.authority_units p
             where p.province_code = x.province_code and p.kind = 'provincia')
      from jsonb_to_recordset(${unitsJson}::jsonb)
        as x(seed_key text, kind text, level text, province_code text, name text, indec_department_code text)
     where x.level <> 'provincial'
    on conflict do nothing
    returning id
  `)) as unknown as unknown[];

  // Before opening: a locality leaving a superseded department unit must be
  // free (one active membership per level) to enter its local government.
  const superseded = await closeSupersededDepartmentMemberships(tx, plan);

  const members = JSON.stringify(
    plan.units.flatMap((u) =>
      u.localityIds.map((id) => ({ seed_key: u.seedKey, locality_id: id })),
    ),
  );
  const opened = (await tx.execute(sql`
    insert into public.authority_unit_localities (unit_id, locality_id)
    select u.id, p.locality_id
      from jsonb_to_recordset(${members}::jsonb) as p(seed_key text, locality_id uuid)
      join public.authority_units u on u.seed_key = p.seed_key
      join public.ar_localities l on l.id = p.locality_id and l.removed_at is null
     where not exists (
       select 1 from public.authority_unit_localities m
        where m.locality_id = p.locality_id and m.valid_to is null and m.level = u.level
     )
    on conflict do nothing
    returning id
  `)) as unknown as unknown[];

  const [kept] = (await tx.execute(sql`
    select count(*)::int as n
      from jsonb_to_recordset(${members}::jsonb) as p(seed_key text, locality_id uuid)
      join public.authority_unit_localities m
        on m.locality_id = p.locality_id and m.valid_to is null and m.level = 'municipal'
      join public.authority_units u on u.id = m.unit_id
     where u.seed_key is distinct from p.seed_key
  `)) as unknown as Array<{ n: number }>;

  return {
    unitsCreated: provincial.length + others.length,
    membershipsOpened: opened.length,
    membershipsClosed: superseded.closed,
    keptElsewhere: kept?.n ?? 0,
    referencedSuperseded: superseded.referenced,
  };
}

/** Every active grant sorted against today's membership (D2). Read-only. */
export async function loadGrantCoverage(tx: Executor): Promise<GrantCoverageReport> {
  const grants = (await tx.execute(sql`
    select id::text as id, user_id::text as user_id, jurisdiction_province as province,
           jurisdiction_locality as locality, locality_id::text as locality_id
      from public.govt_assignments
     where revoked_at is null
  `)) as unknown as Array<{
    id: string;
    user_id: string;
    province: string;
    locality: string;
    locality_id: string | null;
  }>;
  const membership = (await tx.execute(sql`
    select m.locality_id::text as locality_id, m.unit_id::text as unit_id
      from public.authority_unit_localities m
     where m.valid_to is null and m.level = 'municipal'
  `)) as unknown as Array<{ locality_id: string; unit_id: string }>;

  const unitOfLocality = new Map(membership.map((m) => [m.locality_id, m.unit_id]));
  const unitSize = new Map<string, number>();
  for (const m of membership) unitSize.set(m.unit_id, (unitSize.get(m.unit_id) ?? 0) + 1);

  const forReport: GrantForReport[] = grants.map((g) => ({
    id: g.id,
    userId: g.user_id,
    province: g.province,
    locality: g.locality,
    localityId: g.locality_id,
  }));
  return reportGrantCoverage(forReport, unitOfLocality, unitSize);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

class DryRun extends Error {}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const host = targetHost();
  console.log(`[seed-authority-units] target database host: ${host}${dryRun ? " (dry run)" : ""}`);
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--allow-remote")) {
    throw new Error(`refusing ${host}: a non-local database needs --allow-remote`);
  }

  let result: SeedResult | null = null;
  let plan: AuthorityUnitPlan | null = null;
  let report: GrantCoverageReport | null = null;
  let unitNames = new Map<string, string>();
  try {
    await db.transaction(async (tx) => {
      plan = await planFromDatabase(tx);
      result = await applyAuthorityUnitPlan(tx, plan);
      report = await loadGrantCoverage(tx);
      const names = (await tx.execute(sql`
        select id::text as id, name, province_code from public.authority_units
      `)) as unknown as Array<{ id: string; name: string; province_code: string }>;
      unitNames = new Map(names.map((n) => [n.id, `${n.name} (${n.province_code})`]));
      if (dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun || e instanceof TransactionRollbackError)) throw e;
  }

  const p = plan as AuthorityUnitPlan | null;
  const r = result as SeedResult | null;
  const g = report as GrantCoverageReport | null;
  if (!p || !r || !g) throw new Error("the seed did not run");

  console.log(
    `  plan: ${p.units.length} unit(s), ${p.units.reduce((n, u) => n + u.localityIds.length, 0)} placed locality(ies), ${p.excluded.length} excluded by the catalogue guard`,
  );
  console.log(
    `  ${dryRun ? "would write" : "wrote"}: ${r.unitsCreated} unit(s), ${r.membershipsOpened} membership(s) opened, ${r.membershipsClosed} closed in superseded department units; ${r.keptElsewhere} locality(ies) kept where an admin placed them`,
  );
  const noGov = new Map<string, number>();
  for (const l of p.withoutLocalGovernment) {
    noGov.set(l.provinceCode, (noGov.get(l.provinceCode) ?? 0) + 1);
  }
  console.log(
    `  ${p.withoutLocalGovernment.length} locality(ies) with no official local government — the provincial unit covers them: ${[
      ...noGov,
    ]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  for (const u of r.referencedSuperseded) {
    console.warn(
      `  KEPT superseded unit ${u.name} (${u.provinceCode}, ${u.seedKey}): ${u.membershipsKept} membership(s) stay, referenced by ${u.referencedBy.join(", ")} — resolve it by hand`,
    );
  }
  if (p.unplaced.length > 0) {
    console.warn(
      `  WARNING: ${p.unplaced.length} live locality(ies) have no department where the unit comes from the department, and were NOT placed — an admin must place them:`,
    );
    for (const u of p.unplaced.slice(0, 50)) {
      console.warn(`    ${u.provinceCode} ${u.localityName} (${u.id})`);
    }
  }

  console.log(
    `  grants: ${g.complete.length} complete unit holding(s), ${g.partial.length} PARTIAL, ${g.wholeProvince.length} whole-province, ${g.unmapped.length} unmapped`,
  );
  for (const h of g.partial) {
    console.log(
      `    PARTIAL user ${h.userId} holds ${h.held}/${h.unitSize} of ${unitNames.get(h.unitId) ?? h.unitId} — confirm with the authority; access was NOT widened`,
    );
  }
  for (const u of g.unmapped) {
    console.log(
      `    UNMAPPED grant ${u.id} (${u.province} / ${u.locality}): no catalogue id a unit governs — resolve it by hand`,
    );
  }
}

if (process.argv[1]?.endsWith("seed-authority-units.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(`[seed-authority-units] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
