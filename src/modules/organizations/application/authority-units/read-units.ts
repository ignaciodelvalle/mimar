// Reads for the authority-unit editor (localidades-por-id C4): the platform
// admin's /admin/localidades and, for their own province only, a jurisdiction
// admin's /gob/administracion/unidades (jurisdiction-admin Phase 6 — that page
// checks the unit's province before rendering anything). Never an
// authorization: every writer re-checks the actor in its transaction.
//
// The executor comes first so a test can read inside a rolled-back
// transaction. Nothing here is a scope decision: it lists units, their live
// members and their change log — the audit rows the editor wrote, joined to
// the locality they name.

import { sql } from "drizzle-orm";

import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type AuthorityUnitSummary = {
  id: string;
  kind: string;
  level: string;
  name: string;
  status: "draft" | "confirmed";
  /** Live explicit members; `null` for a provincial unit (it covers its province). */
  members: number | null;
};

const LEVEL_ORDER = sql`case u.level when 'provincial' then 0 when 'regional' then 1
  when 'municipal' then 2 else 3 end`;

export async function listAuthorityUnits(
  exec: Executor,
  provinceCode: string,
): Promise<AuthorityUnitSummary[]> {
  const rows = (await exec.execute(sql`
    select u.id::text as id, u.kind, u.level, u.name, u.status,
           case when u.level = 'provincial' then null
                else (select count(*)::int from public.authority_unit_localities m
                       where m.unit_id = u.id and m.valid_to is null) end as members
      from public.authority_units u
     where u.province_code = ${provinceCode}
     order by ${LEVEL_ORDER}, u.name
  `)) as unknown as AuthorityUnitSummary[];
  return rows;
}

export type AuthorityUnitMember = {
  localityId: string;
  localityName: string;
  departmentName: string | null;
  since: Date;
  addedBy: string | null;
};

export type AuthorityUnitChange = {
  action: string;
  performedAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  localityId: string | null;
  localityName: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type AuthorityUnitDetail = Omit<AuthorityUnitSummary, "members"> & {
  provinceCode: string;
  confirmedAt: Date | null;
  /** Live explicit members; empty for a provincial unit (it covers its province). */
  members: AuthorityUnitMember[];
  /** The editor's audit rows about this unit, newest first. */
  changes: AuthorityUnitChange[];
};

export async function loadAuthorityUnitDetail(
  exec: Executor,
  unitId: string,
): Promise<AuthorityUnitDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(unitId)) return null;
  const [unit] = (await exec.execute(sql`
    select u.id::text as id, u.kind, u.level, u.name, u.status,
           u.province_code as "provinceCode", u.confirmed_at as "confirmedAt"
      from public.authority_units u
     where u.id = ${unitId}::uuid
  `)) as unknown as Array<
    Omit<AuthorityUnitSummary, "members"> & {
      provinceCode: string;
      confirmedAt: Date | string | null;
    }
  >;
  if (!unit) return null;

  const members = (await exec.execute(sql`
    select l.id::text as "localityId", l.locality_name as "localityName",
           l.department_name as "departmentName", m.valid_from as since,
           m.added_by::text as "addedBy"
      from public.authority_unit_localities m
      join public.ar_localities l on l.id = m.locality_id
     where m.unit_id = ${unitId}::uuid and m.valid_to is null
     order by l.locality_name, l.id
  `)) as unknown as Array<Omit<AuthorityUnitMember, "since"> & { since: Date | string }>;

  const changes = (await exec.execute(sql`
    select a.action, a.performed_at as "performedAt", a.actor_user_id::text as "actorUserId",
           p.display_name as "actorName",
           a.payload->>'locality_id' as "localityId", l.locality_name as "localityName",
           a.payload->>'reason' as reason,
           a.payload->'before_values' as before, a.payload->'after_values' as after
      from public.audit_log a
      left join public.profiles p on p.id = a.actor_user_id
      left join public.ar_localities l on l.id::text = a.payload->>'locality_id'
     where a.action in ('authority_unit_created', 'authority_unit_renamed',
                        'authority_unit_confirmed', 'authority_unit_membership_moved',
                        'authority_unit_membership_removed', 'govt_assignment_unit_confirmed',
                        'authority_unit_unconfirmed', 'govt_assignment_unit_unconfirmed')
       and (a.payload->>'unit_id' = ${unitId} or a.payload->>'from_unit_id' = ${unitId})
     order by a.performed_at desc, a.id desc
     limit 200
  `)) as unknown as Array<
    Omit<AuthorityUnitChange, "performedAt"> & { performedAt: Date | string }
  >;

  return {
    ...unit,
    confirmedAt: unit.confirmedAt === null ? null : new Date(unit.confirmedAt),
    members: members.map((m) => ({ ...m, since: new Date(m.since) })),
    changes: changes.map((c) => ({ ...c, performedAt: new Date(c.performedAt) })),
  };
}

// ---------------------------------------------------------------------------
// Whom a membership move reaches (localidades-por-id verify S4)
// ---------------------------------------------------------------------------

/** One active govt grant holder of a unit. */
export type UnitHolder = { userId: string; displayName: string };

/**
 * The people whose grant sits on each of `unitIds` today: active (not
 * revoked) grants of active accounts, on CONFIRMED units only — a draft
 * governs nothing (govt_scope, 0260), so nobody gains or loses through it.
 * Moving a locality into a unit widens every one of its holders; moving it
 * out narrows the previous unit's. The editor shows both before the move.
 */
export async function listUnitHolders(
  exec: Executor,
  unitIds: readonly string[],
): Promise<Map<string, UnitHolder[]>> {
  const byUnit = new Map<string, UnitHolder[]>();
  if (unitIds.length === 0) return byUnit;
  const ids = sql.join(
    [...new Set(unitIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await exec.execute(sql`
    select distinct g.authority_unit_id::text as "unitId", g.user_id::text as "userId",
           p.display_name as "displayName"
      from public.govt_assignments g
      join public.authority_units u on u.id = g.authority_unit_id
      join public.profiles p on p.id = g.user_id
     where g.authority_unit_id in (${ids})
       and g.revoked_at is null
       and u.status = 'confirmed'
       and p.deactivated_at is null
     order by 3, 2
  `)) as unknown as Array<{ unitId: string } & UnitHolder>;
  for (const r of rows) {
    const list = byUnit.get(r.unitId) ?? [];
    list.push({ userId: r.userId, displayName: r.displayName });
    byUnit.set(r.unitId, list);
  }
  return byUnit;
}

/**
 * Who gains and who loses a locality when it moves from `fromUnitId` (its
 * unit at that level today, if any) to `toUnitId`. Someone holding a grant on
 * both units keeps it and is in neither list.
 */
export function moveReach(
  holders: ReadonlyMap<string, readonly UnitHolder[]>,
  toUnitId: string,
  fromUnitId: string | null,
): { gaining: UnitHolder[]; losing: UnitHolder[] } {
  const to = holders.get(toUnitId) ?? [];
  const from = fromUnitId === null ? [] : (holders.get(fromUnitId) ?? []);
  const toIds = new Set(to.map((h) => h.userId));
  const fromIds = new Set(from.map((h) => h.userId));
  return {
    gaining: to.filter((h) => !fromIds.has(h.userId)),
    losing: from.filter((h) => !toIds.has(h.userId)),
  };
}

/**
 * The active grants pinned to one unit, by holder — whatever the unit's
 * status, since a grant stays pinned to a unit sent back to draft. What the
 * platform admin's "take the grant off this unit" reversal lists
 * (jurisdiction-admin).
 */
export async function listGrantsOnUnit(
  exec: Executor,
  unitId: string,
): Promise<Array<UnitHolder & { localities: string[] }>> {
  const rows = (await exec.execute(sql`
    select g.user_id::text as "userId", p.display_name as "displayName",
           array_agg(g.jurisdiction_locality order by g.jurisdiction_locality) as localities
      from public.govt_assignments g
      join public.profiles p on p.id = g.user_id
     where g.authority_unit_id = ${unitId}::uuid and g.revoked_at is null
     group by g.user_id, p.display_name
     order by 2, 1
  `)) as unknown as Array<UnitHolder & { localities: string[] }>;
  return rows;
}

/** One locality a unit editor can move into a unit, with whom the move reaches. */
export type LocalityMoveOption = {
  id: string;
  label: string;
  /** Holders of this unit's grants: they gain the locality (verify S4). */
  gaining: string[];
  /** Holders of its current unit at this level: they lose it. */
  losing: string[];
};

/**
 * The province's live localities, labelled with the unit that holds them today,
 * and whom moving each one here reaches (verify S4): the holders of this unit
 * gain it, the holders of its current unit at this level lose it.
 */
export async function listLocalityMoveOptions(
  exec: Executor,
  provinceCode: string,
  level: string,
  unitId: string,
): Promise<LocalityMoveOption[]> {
  const rows = (await exec.execute(sql`
    select l.id::text as id, l.locality_name as name, l.department_name as department,
           u.name as current_unit, u.id::text as current_unit_id
      from public.ar_localities l
      left join public.authority_unit_localities m
        on m.locality_id = l.id and m.valid_to is null and m.level = ${level}
      left join public.authority_units u on u.id = m.unit_id
     where l.province_code = ${provinceCode} and l.removed_at is null
       and m.unit_id is distinct from ${unitId}::uuid
     order by l.locality_name, l.department_name nulls first, l.id
  `)) as unknown as Array<{
    id: string;
    name: string;
    department: string | null;
    current_unit: string | null;
    current_unit_id: string | null;
  }>;
  const holders = await listUnitHolders(exec, [
    unitId,
    ...rows.flatMap((r) => (r.current_unit_id ? [r.current_unit_id] : [])),
  ]);
  return rows.map((r) => {
    const reach = moveReach(holders, unitId, r.current_unit_id);
    return {
      id: r.id,
      label: `${r.name}${r.department ? ` (${r.department})` : ""} — ${
        r.current_unit ? `hoy en ${r.current_unit}` : "sin unidad"
      }`,
      gaining: reach.gaining.map((h) => h.displayName),
      losing: reach.losing.map((h) => h.displayName),
    };
  });
}
