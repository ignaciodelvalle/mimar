// Does an organization work where an animal lives? — the ONE coverage predicate.
//
// WHY IT LIVES HERE AND NOT IN A MODULE (2026-08-22)
// ---------------------------------------------------------------------------
// It was born in src/modules/rehome/domain/rehome-rules.ts (W-4): the picker
// at /mis-mascotas/[publicToken]/buscar-hogar only ever offered orgs whose
// `organization_coverage` reaches the pet's zone, but the request was a server
// action — any titular session could POST any orgId — and a crafted request
// landed a rehome_request in the inbox of an org three provinces away. The
// rehome use-case refuses on this predicate; the page derives its list from it.
//
// The FOSTER half of the same flow (`sendRehomeRequest` in
// src/modules/foster/application/find-rehome-orgs.ts — a tránsito asking an
// org to take an animal in) had the identical hole and needed the identical
// predicate. `foster -> rehome` is not an allowed edge in
// scripts/check-dependency-direction.ts, and adding one to share a pure
// function would legitimise a module dependency that does not exist. A pure
// rule two modules need is what lib/domain/ is for (see
// lib/domain/microchip-implant-site.ts for the same move). rehome-rules.ts
// re-exports these names so its callers and tests are unchanged.
//
// No DB, no framework. The SQL in both pickers mirrors `coverageAreaCoversZone`
// exactly — keep the two in step.

/** One `organization_coverage` row, narrowed to what the predicate reads. */
export type CoverageArea = {
  jurisdictionProvince: string;
  jurisdictionLocality: string | null;
  /** The catalogue row the zone recorded (0248), read on the id path only. */
  localityId?: string | null;
  /** The authority unit the zone is keyed to (0255), read on the id path only. */
  authorityUnitId?: string | null;
  /**
   * A unit zone's ACTIVE member localities (or "province" for a provincial
   * unit), loaded by the caller. A unit zone without it covers nothing on the
   * id path.
   */
  unitLocalityIds?: readonly string[] | "province";
};

/**
 * Where the animal lives — `pets.jurisdiction_province` / `_locality`, and
 * on the id path its catalogue row: `null` = known and unresolved, absent =
 * the caller has not been wired (the name rule applies whatever the mode).
 */
export type PetZone = {
  province: string | null;
  locality: string | null;
  localityId?: string | null;
};

/**
 * The ID PATH (localidades-por-id D5, flag `coverage`). Mirrors
 * lib/place/coverage.ts (the SQL the broadcast runs):
 *   - a unit zone covers its member localities by id (a provincial unit, its
 *     whole province); an unresolved zone never reaches a municipal unit (P1);
 *   - a legacy zone that recorded its catalogue row covers only that row;
 *   - a legacy zone that recorded nothing, a province-wide zone, and an
 *     unresolved zone keep the name rule below.
 */
function coverageAreaCoversZoneById(area: CoverageArea, zone: PetZone): boolean {
  if (!zone.province || area.jurisdictionProvince !== zone.province) return false;
  if (area.authorityUnitId) {
    const members = area.unitLocalityIds;
    if (members === "province") return true;
    if (!members || !zone.localityId) return false;
    return members.includes(zone.localityId);
  }
  if (area.jurisdictionLocality === null) return true;
  if (zone.localityId && area.localityId) return area.localityId === zone.localityId;
  return coverageAreaCoversZone(area, zone);
}

/**
 * One coverage row against one zone. The locality half is deliberately
 * asymmetric, because the picker's SQL is:
 *
 *   - pet HAS a locality → the row matches on that locality, or is
 *     province-wide (`jurisdiction_locality IS NULL`);
 *   - pet has NO locality → the query drops the locality predicate entirely,
 *     so every row in the province matches.
 *
 * A pet with no province matches nothing: the picker returns an empty list
 * and shows "no tiene provincia registrada".
 */
export function coverageAreaCoversZone(area: CoverageArea, zone: PetZone): boolean {
  if (!zone.province) return false;
  if (area.jurisdictionProvince !== zone.province) return false;
  if (zone.locality === null) return true;
  return area.jurisdictionLocality === null || area.jurisdictionLocality === zone.locality;
}

/**
 * Any-of over the org's coverage rows. No rows at all covers nothing. `mode`
 * is the `coverage` flag's reading, resolved by the caller (this stays pure);
 * a zone with no `localityId` field always takes the name rule.
 */
export function orgCoversZone(
  areas: readonly CoverageArea[],
  zone: PetZone,
  mode: "name" | "id" = "name",
): boolean {
  const byId = mode === "id" && zone.localityId !== undefined;
  return areas.some((area) =>
    byId ? coverageAreaCoversZoneById(area, zone) : coverageAreaCoversZone(area, zone),
  );
}
