// Org coverage on the ID path — localidades-por-id D5 (flag `coverage`).
//
// The SQL twin of coverageAreaCoversZoneById (lib/domain/org-coverage.ts):
// does an organization_coverage row reach a place?
//
//   - a row keyed to an authority unit reaches the place when a CONFIRMED
//     unit governing it (public.authority_units_for_place) is that unit: its
//     member localities by id, or its whole province for a provincial unit.
//     An unresolved place reaches only a provincial unit (P1); a draft unit
//     governs nothing (stage D review W1).
//   - a legacy row (unit NULL) of the place's province: a province-wide row
//     (locality NULL) always reaches it; a row that recorded its catalogue row
//     reaches only that row; a row that recorded nothing keeps the name rule,
//     and so does a place with no locality_id (the locality-less rule: every
//     row of the province).
//
// A place with no locality_id at all (the caller was not wired) never comes
// here: the broadcast keeps the name path for it.

import { type SQL, eq, sql } from "drizzle-orm";

import { db, organizationCoverage } from "@/db";
import type { CoverageArea } from "@/lib/domain/org-coverage";
import { readPlaceFlag } from "@/lib/place/flags";
import { provinceByName } from "@/lib/reference/ar-provincias";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type CoveragePlace = {
  province: string;
  locality: string | null;
  /** The place's catalogue row; null = unresolved. */
  localityId: string | null;
};

export function coverageCoversPlaceById(place: CoveragePlace): SQL {
  const oc = organizationCoverage;
  const provinceCode = provinceByName(place.province)?.code ?? null;
  const unitBranch = sql`(${oc.authorityUnitId} IS NOT NULL AND ${oc.authorityUnitId} IN (
    SELECT f.unit_id FROM public.authority_units_for_place(${place.localityId}::uuid, ${provinceCode}) f
      JOIN public.authority_units u ON u.id = f.unit_id AND u.status = 'confirmed'))`;
  let legacyLocality: SQL;
  if (place.locality === null) {
    legacyLocality = sql`true`;
  } else if (place.localityId === null) {
    legacyLocality = sql`(${oc.jurisdictionLocality} = ${place.locality})`;
  } else {
    legacyLocality = sql`((${oc.localityId} IS NOT NULL AND ${oc.localityId} = ${place.localityId}::uuid)
      OR (${oc.localityId} IS NULL AND ${oc.jurisdictionLocality} = ${place.locality}))`;
  }
  const legacyBranch = sql`(${oc.authorityUnitId} IS NULL AND ${oc.jurisdictionProvince} = ${place.province}
    AND (${oc.jurisdictionLocality} IS NULL OR ${legacyLocality}))`;
  return sql`(${unitBranch} OR ${legacyBranch})`;
}

/**
 * The `coverage` flag as the pure predicate reads it: 'id' or 'name'
 * ('shadow' serves the name path; the broadcast is where it records).
 */
export async function coverageDecisionMode(): Promise<"name" | "id"> {
  return (await readPlaceFlag("coverage")) === "id" ? "id" : "name";
}

/**
 * Fill `unitLocalityIds` on the unit zones: a CONFIRMED provincial unit is
 * "province", any other confirmed unit its ACTIVE member localities, and a
 * draft unit nothing at all (it governs nothing — stage D review W1).
 */
export async function expandUnitZones<T extends CoverageArea>(
  exec: Executor,
  areas: readonly T[],
): Promise<T[]> {
  const unitIds = [...new Set(areas.map((a) => a.authorityUnitId).filter((v): v is string => !!v))];
  if (unitIds.length === 0) return [...areas];
  const rows = (await exec.execute(sql`
    select u.id::text as id, u.kind, u.status,
           coalesce(array_agg(m.locality_id::text) filter (where m.locality_id is not null), '{}') as members
      from public.authority_units u
      left join public.authority_unit_localities m on m.unit_id = u.id and m.valid_to is null
     where u.id in (${sql.join(
       unitIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     group by u.id, u.kind, u.status
  `)) as unknown as Array<{ id: string; kind: string; status: string; members: string[] }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return areas.map((a) => {
    if (!a.authorityUnitId) return a;
    const unit = byId.get(a.authorityUnitId);
    if (!unit || unit.status !== "confirmed") return { ...a, unitLocalityIds: [] };
    return { ...a, unitLocalityIds: unit.kind === "provincia" ? "province" : unit.members };
  });
}

/** One organization's coverage zones, id-aware (the id path reads them all). */
export async function loadOrgCoverageAreas(
  orgId: string,
  exec: Executor = db,
): Promise<CoverageArea[]> {
  const rows = await exec
    .select({
      jurisdictionProvince: organizationCoverage.jurisdictionProvince,
      jurisdictionLocality: organizationCoverage.jurisdictionLocality,
      localityId: organizationCoverage.localityId,
      authorityUnitId: organizationCoverage.authorityUnitId,
    })
    .from(organizationCoverage)
    .where(eq(organizationCoverage.organizationId, orgId));
  return expandUnitZones(exec, rows);
}
