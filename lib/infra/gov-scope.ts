// lib/gov-scope.ts — Shared scoping helpers for the gov-visibility build.
//
// PURE helpers (unit-tested, no DB):
//   resolveScopedJurisdictions — narrows jurisdiction list by selected province/locality
//   computeBounds              — computes [[minLng,minLat],[maxLng,maxLat]] or null
//
// DB-bound helpers (tsc-only):
//   jurisdictionBounds — queries ar_localities for centroids of assigned jurisdictions

import { and, isNotNull, isNull, or, sql } from "drizzle-orm";

import { arLocalities, db } from "@/db";
import {
  type GobReadRole,
  hasNationalReadScope,
  narrowGovtScope,
} from "@/lib/domain/jurisdiction-canonical";
import { provinceByName } from "@/lib/reference/ar-provincias";

import type { DashboardJurisdiction } from "@/lib/metrics";

// Re-export for callers that import from this module.
export type { DashboardJurisdiction } from "@/lib/metrics";

// ---------------------------------------------------------------------------
// PURE helpers
// ---------------------------------------------------------------------------

/**
 * Narrows `jurisdictions` to the selected province (and optionally locality)
 * when the caller is a govt user. Admin always receives the list unchanged.
 *
 * This is the single source of truth for the scoping logic that was previously
 * duplicated in app/gob/censo/page.tsx (lines 88-98) and
 * app/gob/panorama/page.tsx (lines 58-65).
 *
 * Security guarantee: a govt user can never widen beyond their own assignments
 * because this function only NARROWS the list they were already given.
 *
 * Admin (role === "admin") → returned as-is (empty jurisdictions = universal).
 * Govt + no selection → returned as-is (all assignments visible).
 * Govt + province selected → filtered to that province.
 * Govt + province + locality selected → narrowed to that single unit, WITH
 *   whole-province subsumption (see below).
 *
 * WHOLE-PROVINCE SUBSUMPTION — why this delegates instead of filtering inline.
 * This function used to close with an exact-pair filter:
 *
 *     j.province === selectedProvinceName && j.locality === selectedLocalityName
 *
 * which erased a WHOLE-PROVINCE assignment the moment a locality was picked:
 * that row's locality is the `""` sentinel (or the CABA whole-city entry), never
 * a barrio name, so the filter returned `[]`, lib/metrics/scope.ts compiled that
 * to `sql`false``, and a provincial operator's own dashboard came back empty for
 * data they plainly govern. It fails CLOSED, so it is not a leak — it is the
 * central feature breaking for exactly the class of official being onboarded.
 *
 * It was also reachable by invitation, not by accident: `resolveJurisdictionScope`
 * feeds the locality switcher through `constrainLocalitiesToMandate`, which
 * deliberately OFFERS every barrio to a whole-province operator. The UI led them
 * to the one selection this filter could not answer.
 *
 * `narrowGovtScope` is the same fix already made for Panorama (critique of PR
 * #762) and for the appointment search (`localitiesCoveringSearch`); its own
 * docstring notes each time it failed to reach a third caller. This was the
 * third caller. Delegating — rather than re-implementing the predicate here —
 * is what keeps there from being a fourth.
 */
export function resolveScopedJurisdictions(args: {
  jurisdictions: DashboardJurisdiction[];
  role: GobReadRole;
  selectedProvinceName?: string | null;
  selectedLocalityName?: string | null;
}): DashboardJurisdiction[] {
  const { jurisdictions, role, selectedProvinceName, selectedLocalityName } = args;

  // admin | national: universal read scope — the list comes back unchanged
  // (empty = universal). Their URL selection is a DRILL applied as an explicit
  // predicate elsewhere, never a narrowing of this list.
  if (hasNationalReadScope(role)) return jurisdictions;

  return narrowGovtScope(jurisdictions, selectedProvinceName, selectedLocalityName);
}

// ---------------------------------------------------------------------------
// computeBounds — PURE
// ---------------------------------------------------------------------------

/**
 * Computes the bounding box of a set of lat/lng points.
 *
 * Returns `[[minLng, minLat], [maxLng, maxLat]]` in MapLibre/GeoJSON order
 * (longitude first), or `null` when the input is empty.
 */
export function computeBounds(
  points: { lat: number; lng: number }[],
): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;

  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

// ---------------------------------------------------------------------------
// jurisdictionBounds — DB-bound (tsc-only in unit tests)
// ---------------------------------------------------------------------------

/**
 * Queries `ar_localities` for the centroids of the given jurisdiction
 * assignments and returns a MapLibre bounding box, or `null` when:
 *  - `jurisdictions` is empty (admin universal scope → caller falls back to national)
 *  - no matching localities with valid coordinates are found
 *
 * Province names in `jurisdictions` are stored as canonical display names
 * (e.g. "Buenos Aires", "CABA") that match `ar_localities.province_code` via
 * `provinceByName` → ISO code (e.g. "AR-B", "AR-C"). Locality matching uses
 * the `locality_name` column (exact, case-sensitive — names are normalized at
 * import time).
 *
 * Callers should fall back to a national bounding box when this returns null.
 */
export async function jurisdictionBounds(
  jurisdictions: DashboardJurisdiction[],
): Promise<[[number, number], [number, number]] | null> {
  // Admin (empty jurisdictions = universal scope) → no spatial restriction.
  if (jurisdictions.length === 0) return null;

  // Map jurisdiction province names → ISO codes for the DB query.
  // Pairs where the province name cannot be resolved are skipped; this is
  // safe because those jurisdictions simply contribute no centroid rows.
  const resolved = jurisdictions.flatMap((j) => {
    const prov = provinceByName(j.province);
    if (!prov) return [];
    return [{ provinceCode: prov.code, localityName: j.locality }];
  });

  if (resolved.length === 0) return null;

  // Build OR of (province_code, locality_name) pairs.
  const pairClauses = resolved.map(
    ({ provinceCode, localityName }) =>
      sql`(${arLocalities.provinceCode} = ${provinceCode} AND ${arLocalities.localityName} = ${localityName})`,
  );

  const rows = await db
    .select({
      latitude: arLocalities.latitude,
      longitude: arLocalities.longitude,
    })
    .from(arLocalities)
    .where(
      and(
        isNull(arLocalities.removedAt),
        isNotNull(arLocalities.latitude),
        isNotNull(arLocalities.longitude),
        or(...pairClauses),
      ),
    );

  const points = rows.flatMap((r) => {
    const lat = r.latitude !== null ? Number(r.latitude) : null;
    const lng = r.longitude !== null ? Number(r.longitude) : null;
    if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) return [];
    return [{ lat, lng }];
  });

  return computeBounds(points);
}
