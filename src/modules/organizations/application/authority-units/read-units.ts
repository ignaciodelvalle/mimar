// Reads for the /admin/localidades unit editor (localidades-por-id C4).
//
// Platform-admin only (the page and its actions are behind the /admin guard);
// the executor comes first so a test can read inside a rolled-back
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
                        'authority_unit_membership_removed')
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
