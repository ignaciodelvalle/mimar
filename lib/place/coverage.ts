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

import { type SQL, sql } from "drizzle-orm";

import { organizationCoverage } from "@/db";
import { provinceByName } from "@/lib/reference/ar-provincias";

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
