// Reads for a jurisdiction admin's /gob/administracion (SDD jurisdiction-admin,
// Phase 6): the municipal officials of ONE province and what the admin may do
// to each.
//
// Read-only and never an authorization: the pages are gated by
// requireAdministrationPrincipalOrRedirect, and every writer re-derives the
// target's province and re-checks the actor inside its own transaction. The
// `canAct` flag below only decides which forms are OFFERED; it restates the
// writers' refusals (self, another appointee, a funcionario with grants in a
// second province) so an admin is not handed a form that can only fail.
//
// Only the province's own grants are ever returned: a funcionario who also
// holds a grant elsewhere is listed, but where else stays unsaid.
//
// Executor-first, like the writers, so tests read inside their rollback.

import { sql } from "drizzle-orm";

import type { db } from "@/db";

import { govtTargetProvince } from "./target-province";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ProvinceAdministrationExecutor = typeof db | Tx;

/** Why the admin is not offered an act on a funcionario, or null. */
export type FuncionarioLock = "self" | "appointee" | "other_province" | null;

export type ProvinceFuncionario = {
  userId: string;
  displayName: string;
  /** The province's active grants only ('' = the whole province). */
  localities: string[];
  lock: FuncionarioLock;
};

type FuncionarioRow = {
  user_id: string;
  display_name: string;
  localities: string[] | null;
  foreign_grants: boolean;
  appointee: boolean;
};

function lockOf(row: FuncionarioRow, viewerId: string): FuncionarioLock {
  if (row.user_id === viewerId) return "self";
  if (row.appointee) return "appointee";
  if (row.foreign_grants) return "other_province";
  return null;
}

async function selectFuncionarios(
  exec: ProvinceAdministrationExecutor,
  provinceCode: string,
  userId: string | null,
): Promise<FuncionarioRow[]> {
  return (await exec.execute(sql`
    select p.id::text as user_id,
           p.display_name,
           array_agg(g.jurisdiction_locality order by g.jurisdiction_locality)
             filter (where public.ar_province_code(g.jurisdiction_province) = ${provinceCode})
             as localities,
           bool_or(public.ar_province_code(g.jurisdiction_province)
                     is distinct from ${provinceCode}) as foreign_grants,
           exists (select 1 from public.jurisdiction_admin_appointments a
                    where a.user_id = p.id and a.revoked_at is null) as appointee
      from public.profiles p
      join public.govt_assignments g on g.user_id = p.id and g.revoked_at is null
     where p.role = 'govt'
       and p.account_type = 'institutional'
       and p.deactivated_at is null
       and p.deleted_at is null
       and (${userId}::uuid is null or p.id = ${userId}::uuid)
     group by p.id, p.display_name
    having bool_or(public.ar_province_code(g.jurisdiction_province) = ${provinceCode})
     order by p.display_name, p.id`)) as unknown as FuncionarioRow[];
}

/** The active municipal officials holding at least one grant in the province. */
export async function listProvinceFuncionarios(
  exec: ProvinceAdministrationExecutor,
  provinceCode: string,
  viewerId: string,
): Promise<ProvinceFuncionario[]> {
  const rows = await selectFuncionarios(exec, provinceCode, null);
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    localities: r.localities ?? [],
    lock: lockOf(r, viewerId),
  }));
}

export type ProvinceFuncionarioGrant = {
  assignmentId: string;
  locality: string;
  grantedAt: Date;
};

export type ProvinceFuncionarioDetail = {
  userId: string;
  displayName: string;
  grants: ProvinceFuncionarioGrant[];
  lock: FuncionarioLock;
};

/**
 * One funcionario of the province, or null — for a malformed id, an unknown
 * account, a deactivated one, or one with no active grant in the province
 * alike (the page answers 404 to all of them, so it is no oracle).
 */
export async function loadProvinceFuncionario(
  exec: ProvinceAdministrationExecutor,
  provinceCode: string,
  userId: string,
  viewerId: string,
): Promise<ProvinceFuncionarioDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [row] = await selectFuncionarios(exec, provinceCode, userId);
  if (!row) return null;
  const grants = (await exec.execute(sql`
    select g.id::text as assignment_id, g.jurisdiction_locality as locality, g.granted_at
      from public.govt_assignments g
     where g.user_id = ${userId}::uuid
       and g.revoked_at is null
       and public.ar_province_code(g.jurisdiction_province) = ${provinceCode}
     order by g.jurisdiction_locality, g.id`)) as unknown as Array<{
    assignment_id: string;
    locality: string;
    granted_at: Date | string;
  }>;
  // The writers' own resolver decides "single province"; the list query's
  // flag is its restatement for many rows at once.
  const target = await govtTargetProvince(exec, userId);
  const lock =
    lockOf(row, viewerId) ??
    (target.kind === "single" && target.provinceCode === provinceCode ? null : "other_province");
  return {
    userId: row.user_id,
    displayName: row.display_name,
    grants: grants.map((g) => ({
      assignmentId: g.assignment_id,
      locality: g.locality,
      grantedAt: new Date(g.granted_at),
    })),
    lock,
  };
}
