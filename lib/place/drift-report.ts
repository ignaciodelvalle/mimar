// Catalogue drift report — localidades-por-id E3 (design "Catalogue drift").
//
// The INDEC importer (scripts/import-indec-localities.ts) changes the catalogue
// under rows that already point at it by id:
//
//   RENAMED  the same id now carries another name. Every cache row that stored
//            the old text (jurisdiction_locality next to its locality_id) now
//            disagrees with its own catalogue row.
//   REMOVED  the id is soft-removed (removed_at). Rows, event places, place
//            resolutions and authority-unit memberships still point at it.
//            The resolver already refuses a removed id for NEW writes (it
//            falls to the name, resolve-place.ts step 1); what exists stays.
//
// This module only READS. It lists; it never rewrites a cache row, never
// closes a membership and never re-points an id:
//   - a renamed pet's jurisdiction_locality is a cache of the event spine
//     (rederivePetCache checks it strictly), so refreshing it without an event
//     would itself be drift;
//   - a legacy grant's name pair (govt_assignments) IS its scope on the name
//     path, so rewriting it would change what an operator sees;
//   - a removed locality's successor (a split, a merge, a re-issued id) is a
//     person's call: live rows of the same province with the same slug are
//     offered as CANDIDATES, never chosen (P1).
// Closing a removed locality's membership is the admin's explicit act on
// /admin/localidades (removed-locality-memberships.ts).
//
// A stored name that differs from its catalogue row is not always a rename:
// the unresolved queue keeps the entered text on the rows it resolves
// (place_method 'admin_queue'). Each group carries its method so the reader
// can tell them apart.

import { sql } from "drizzle-orm";

import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DriftExecutor = typeof db | Tx;

/** Every table whose rows store a catalogue id next to the display pair. */
export const DRIFT_PAIR_TABLES: ReadonlyArray<{
  table: string;
  idColumn: string;
  localityColumn: string;
}> = [
  ...[
    "pets",
    "cases",
    "welfare_reports",
    "govt_assignments",
    "organizations",
    "organization_coverage",
    "service_offerings",
    "govt_business_rules",
    "alert_subscriptions",
    "alert_firings",
    "foster_volunteers",
    "approval_requests",
    "custody_disputes",
  ].map((table) => ({ table, idColumn: "locality_id", localityColumn: "jurisdiction_locality" })),
  {
    table: "event_notification_outbox",
    idColumn: "target_locality_id",
    localityColumn: "target_jurisdiction_locality",
  },
];

/** Tables that point at a catalogue id without storing a name. */
export const DRIFT_ID_ONLY_TABLES = [
  { table: "event_places", idColumn: "locality_id" },
  { table: "place_resolutions", idColumn: "locality_id" },
] as const;

/** Tables with no `place_method` column (the method reads as null). */
const NO_METHOD_COLUMN = new Set<string>(["govt_assignments"]);
const METHOD_COLUMN: Record<string, string> = { event_notification_outbox: "target_place_method" };

export type RenamedGroup = {
  table: string;
  localityId: string;
  storedName: string | null;
  catalogueName: string;
  method: string | null;
  rows: number;
};

export type SuccessorCandidate = {
  localityId: string;
  name: string;
  department: string | null;
};

export type RemovedReference = {
  localityId: string;
  localityName: string;
  provinceCode: string;
  department: string | null;
  removedAt: Date;
  /** table -> rows still pointing at the removed id. */
  rowsByTable: Record<string, number>;
  /** Active authority-unit memberships of the removed id. */
  activeMemberships: number;
  /** Live rows of the province with the same slug; never chosen. */
  successorCandidates: SuccessorCandidate[];
};

export type PlaceDriftReport = {
  renamed: RenamedGroup[];
  removed: RemovedReference[];
};

function ident(name: string) {
  return sql.identifier(name);
}

async function renamedGroups(exec: DriftExecutor): Promise<RenamedGroup[]> {
  const out: RenamedGroup[] = [];
  for (const t of DRIFT_PAIR_TABLES) {
    const method = NO_METHOD_COLUMN.has(t.table)
      ? sql`null::text`
      : sql`t.${ident(METHOD_COLUMN[t.table] ?? "place_method")}`;
    const rows = (await exec.execute(sql`
      select t.${ident(t.idColumn)}::text as "localityId",
             t.${ident(t.localityColumn)} as "storedName",
             l.locality_name as "catalogueName",
             ${method} as method,
             count(*)::int as rows
        from public.${ident(t.table)} t
        join public.ar_localities l on l.id = t.${ident(t.idColumn)}
       where l.removed_at is null
         and t.${ident(t.localityColumn)} is distinct from l.locality_name
       group by 1, 2, 3, 4
       order by 3, 2
    `)) as unknown as Array<Omit<RenamedGroup, "table">>;
    for (const r of rows) out.push({ table: t.table, ...r });
  }
  return out;
}

async function removedReferences(exec: DriftExecutor): Promise<RemovedReference[]> {
  const counts = new Map<string, Record<string, number>>();
  const all = [...DRIFT_PAIR_TABLES, ...DRIFT_ID_ONLY_TABLES];
  for (const t of all) {
    const rows = (await exec.execute(sql`
      select t.${ident(t.idColumn)}::text as "localityId", count(*)::int as rows
        from public.${ident(t.table)} t
        join public.ar_localities l on l.id = t.${ident(t.idColumn)}
       where l.removed_at is not null
       group by 1
    `)) as unknown as Array<{ localityId: string; rows: number }>;
    for (const r of rows) {
      const byTable = counts.get(r.localityId) ?? {};
      byTable[t.table] = r.rows;
      counts.set(r.localityId, byTable);
    }
  }

  const memberships = (await exec.execute(sql`
    select m.locality_id::text as "localityId", count(*)::int as rows
      from public.authority_unit_localities m
      join public.ar_localities l on l.id = m.locality_id
     where l.removed_at is not null and m.valid_to is null
     group by 1
  `)) as unknown as Array<{ localityId: string; rows: number }>;
  const membershipsById = new Map(memberships.map((m) => [m.localityId, m.rows]));

  const ids = [...new Set([...counts.keys(), ...membershipsById.keys()])];
  if (ids.length === 0) return [];

  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const details = (await exec.execute(sql`
    select l.id::text as "localityId", l.locality_name as "localityName",
           l.province_code as "provinceCode", l.department_name as department,
           l.removed_at as "removedAt",
           coalesce((
             select json_agg(json_build_object(
                      'localityId', s.id::text, 'name', s.locality_name,
                      'department', s.department_name)
                    order by s.locality_name, s.department_name, s.id)
               from public.ar_localities s
              where s.province_code = l.province_code
                and s.locality_slug = l.locality_slug
                and s.removed_at is null
                and s.id <> l.id
           ), '[]'::json) as successors
      from public.ar_localities l
     where l.id in (${idList})
     order by l.removed_at, l.province_code, l.locality_name
  `)) as unknown as Array<{
    localityId: string;
    localityName: string;
    provinceCode: string;
    department: string | null;
    removedAt: Date | string;
    successors: SuccessorCandidate[] | string;
  }>;

  return details.map((d) => ({
    localityId: d.localityId,
    localityName: d.localityName,
    provinceCode: d.provinceCode,
    department: d.department,
    removedAt: new Date(d.removedAt),
    rowsByTable: counts.get(d.localityId) ?? {},
    activeMemberships: membershipsById.get(d.localityId) ?? 0,
    successorCandidates:
      typeof d.successors === "string"
        ? (JSON.parse(d.successors) as SuccessorCandidate[])
        : d.successors,
  }));
}

/** Everything that points at a renamed or removed catalogue row. Read-only. */
export async function collectPlaceDrift(exec: DriftExecutor): Promise<PlaceDriftReport> {
  return { renamed: await renamedGroups(exec), removed: await removedReferences(exec) };
}

/** Human-readable lines for the CLI and the importer's closing summary. */
export function formatPlaceDrift(report: PlaceDriftReport): string[] {
  const lines: string[] = [];
  const renamedRows = report.renamed.reduce((n, g) => n + g.rows, 0);
  lines.push(
    `renamed: ${report.renamed.length} group(s), ${renamedRows} row(s) store a name their catalogue id no longer carries`,
  );
  for (const g of report.renamed) {
    lines.push(
      `  ${g.table} ${g.localityId}: "${g.storedName ?? "(null)"}" -> "${g.catalogueName}" (${g.rows} row(s), method ${g.method ?? "n/a"})`,
    );
  }
  lines.push(`removed: ${report.removed.length} removed catalogue row(s) still referenced`);
  for (const r of report.removed) {
    const tables = Object.entries(r.rowsByTable)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    const successors =
      r.successorCandidates.length === 0
        ? "none"
        : r.successorCandidates
            .map((s) => `${s.name}${s.department ? ` (${s.department})` : ""} ${s.localityId}`)
            .join("; ");
    lines.push(
      `  ${r.provinceCode} ${r.localityName}${r.department ? ` (${r.department})` : ""} ${r.localityId}, removed ${r.removedAt.toISOString().slice(0, 10)}: ${tables || "no rows"}; active memberships ${r.activeMemberships}; successor candidates: ${successors}`,
    );
  }
  return lines;
}
