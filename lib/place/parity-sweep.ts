// The place parity sweep — localidades-por-id D7, the flip gate for the
// `scope` consumer (design "Shadow comparator").
//
// For every govt user with an active grant it asks both paths the question a
// scope clause answers — which pets, cases and welfare reports does this user
// see? — using the SAME primitive production uses (jurisdictionPairClause over
// scopedGrants, mode 'name' vs 'id'), and classifies every row where they
// disagree (lib/place/shadow.ts). The flip gate is flipGateVerdict: zero
// `other` and zero `legacy_grant`. The runtime half of the gate (seven days of
// place_shadow_disagreements with no blocking kind) belongs to the consumers
// running in 'shadow'.
//
// Offline and read-only: scope in production is never run twice. The CLI is
// scripts/place-parity-sweep.ts.

import { type SQL, and, eq, isNull, sql } from "drizzle-orm";

import { cases, type db, govtAssignments, pets, welfareReports } from "@/db";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { scopedGrants } from "@/lib/place/scope";
import {
  type ShadowCounts,
  type ShadowKind,
  classifyShadow,
  flipGateVerdict,
} from "@/lib/place/shadow";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type SweepRow = {
  userId: string;
  subjectTable: string;
  subjectId: string;
  kind: ShadowKind;
};

export type SweepReport = {
  usersSwept: number;
  rows: SweepRow[];
  counts: ShadowCounts;
  verdict: { pass: boolean; blocking: ShadowCounts };
};

type PlaceTable = typeof pets | typeof cases | typeof welfareReports;

const TABLES: ReadonlyArray<{ name: string; table: PlaceTable }> = [
  { name: "pets", table: pets },
  { name: "cases", table: cases },
  { name: "welfare_reports", table: welfareReports },
];

type Diff = {
  id: string;
  localityId: string | null;
  byName: boolean;
  byId: boolean;
  ambiguous: boolean;
  folds: boolean | null;
};

async function diffsFor(
  exec: Executor,
  t: PlaceTable,
  nameClause: SQL,
  idClause: SQL,
): Promise<Diff[]> {
  return (await exec.execute(sql`
    select ${t.id}::text as id, ${t.localityId}::text as "localityId",
           coalesce(${nameClause}, false) as "byName",
           coalesce(${idClause}, false) as "byId",
           (select count(*) from public.ar_localities l
             where l.province_code = public.ar_province_code(${t.jurisdictionProvince})
               and l.locality_name = ${t.jurisdictionLocality}
               and l.removed_at is null) > 1 as ambiguous,
           (select l.locality_name_norm = btrim(regexp_replace(lower(translate(
                     public.immutable_unaccent(${t.jurisdictionLocality}), '.', '')), '\\s+', ' ', 'g'))
              from public.ar_localities l where l.id = ${t.localityId}) as folds
      from ${t}
     where coalesce(${nameClause}, false) <> coalesce(${idClause}, false)
  `)) as unknown as Diff[];
}

export async function sweepScopeParity(
  exec: Executor,
  opts: { userIds?: string[] } = {},
): Promise<SweepReport> {
  const userIds =
    opts.userIds ??
    (
      (await exec.execute(sql`
        select distinct user_id::text as id from public.govt_assignments
         where revoked_at is null order by 1
      `)) as unknown as Array<{ id: string }>
    ).map((r) => r.id);

  const rows: SweepRow[] = [];
  for (const userId of userIds) {
    const grants = await exec
      .select({
        assignmentId: govtAssignments.id,
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
        authorityUnitId: govtAssignments.authorityUnitId,
        localityId: govtAssignments.localityId,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
    if (grants.length === 0) continue;
    const legacyOnly = grants.every((g) => g.authorityUnitId === null);
    const grantRows = new Set(grants.map((g) => g.localityId).filter((v) => v !== null));
    const byName = await scopedGrants(userId, grants, { exec, mode: "name" });
    const byId = await scopedGrants(userId, grants, { exec, mode: "id" });

    for (const { name, table } of TABLES) {
      // synthetic: exempt — an offline comparison of the two scope paths over
      // every row, synthetic ones included on both sides; nothing is shown to
      // a viewer, only counted.
      const clause = (list: typeof byName) =>
        jurisdictionPairClause(
          list,
          sql`${table.jurisdictionProvince}`,
          sql`${table.jurisdictionLocality}`,
          sql`${table.localityId}`,
        ) ?? sql`false`;
      for (const d of await diffsFor(exec, table, clause(byName), clause(byId))) {
        const kind = classifyShadow({
          namePath: d.byName,
          idPath: d.byId,
          legacyOnly,
          rowLocalityId: d.localityId,
          rowNameAmbiguous: d.ambiguous,
          rowNameFoldsToCatalogue: d.folds === true,
          grantNamesRowLocality: d.localityId !== null && grantRows.has(d.localityId),
        });
        if (kind) rows.push({ userId, subjectTable: name, subjectId: d.id, kind });
      }
    }
  }

  const counts: ShadowCounts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return { usersSwept: userIds.length, rows, counts, verdict: flipGateVerdict(counts) };
}
