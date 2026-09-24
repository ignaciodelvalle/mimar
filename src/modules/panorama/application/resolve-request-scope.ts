// Panorama request-scope resolution — the SINGLE narrowing block shared by the
// two panorama pages (app/admin/panorama, app/gob/panorama) and the two data
// API routes (app/api/panorama/kpis, app/api/panorama/[layer]). Before WP3 of
// the decrowding program this block was re-implemented in all four files.
//
// What it resolves, from the request's raw ?province/?locality params:
//   - `provinceObj`: the canonical province for the ISO code param (or null).
//   - `localityRow`: the canonical locality row via the alias-tolerant
//     localityByName resolver (only when a province is also selected).
//   - `scoped`: the viewer's EFFECTIVE jurisdictions. A govt viewer's selection
//     is INTERSECTED with their actual assignments — crafted params can never
//     widen scope. narrowGovtScope applies whole-province SUBSUMPTION: a
//     whole-province assignment narrows to the selected locality instead of
//     being emptied by an exact-locality mismatch (critique of PR #762,
//     finding 4). An admin keeps their raw assignments ([] = universal scope;
//     the scope clauses short-circuit on admin).
//   - `adminProvince`/`adminLocality`: the ADMIN drill-down, as canonical
//     STORED names derived server-side from provinceByCode()/localityByName().
//     Only set for the admin role — govt actors must NOT receive these; their
//     scope is enforced by `scoped`.

import {
  type GobReadRole,
  hasNationalReadScope,
  narrowGovtScope,
} from "@/lib/domain/jurisdiction-canonical";
import { type Locality, localityByName } from "@/lib/infra/ar-localidades";
import type { DashboardJurisdiction } from "@/lib/metrics";
import { type Province, type ProvinceCode, provinceByCode } from "@/lib/reference/ar-provincias";

/** The resolved scope of one panorama request (page render or API call). */
export type PanoramaRequestScope = {
  /** Canonical province for the ?province ISO code, or null (national view). */
  provinceObj: Province | null;
  /** Canonical locality row for the ?locality param, or null. */
  localityRow: Locality | null;
  /** Effective jurisdictions the data loaders enforce (see module header). */
  scoped: DashboardJurisdiction[];
  /** Admin drill-down province name (canonical stored form). Admin only. */
  adminProvince: string | undefined;
  /** Admin drill-down locality name (canonical stored form). Admin only. */
  adminLocality: string | undefined;
};

/**
 * Resolve a panorama request's effective scope from its raw query params and
 * the viewer's session (role + assignments). Read-only: one alias-tolerant
 * locality lookup at most, no other I/O.
 */
export async function resolvePanoramaRequestScope(args: {
  role: GobReadRole;
  jurisdictions: DashboardJurisdiction[];
  /** Raw ?province param (ISO 3166-2:AR code), if any. */
  province: string | null | undefined;
  /** Raw ?locality param (name or slug — localityByName tolerates both). */
  locality: string | null | undefined;
}): Promise<PanoramaRequestScope> {
  const { role, jurisdictions } = args;
  // admin | national read the whole country: their URL selection is a DRILL
  // (explicit predicate), never a mandate intersection.
  const universal = hasNationalReadScope(role);

  // Resolve the selected province/locality once — shared by govt
  // scope-narrowing and admin drill-down below.
  const provinceObj = args.province ? provinceByCode(args.province) : null;
  const localityRow =
    provinceObj && args.locality
      ? await localityByName(provinceObj.code as ProvinceCode, args.locality)
      : null;

  // Intersect scope with the viewer's assignments (never widens for govt).
  const scoped: DashboardJurisdiction[] =
    provinceObj && !universal
      ? narrowGovtScope(jurisdictions, provinceObj.name, localityRow?.localityName ?? null)
      : jurisdictions;

  const adminProvince = universal ? (provinceObj?.name ?? undefined) : undefined;
  const adminLocality = universal ? (localityRow?.localityName ?? undefined) : undefined;

  return { provinceObj, localityRow, scoped, adminProvince, adminLocality };
}
