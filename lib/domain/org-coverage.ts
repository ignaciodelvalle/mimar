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
};

/** Where the animal lives — `pets.jurisdiction_province` / `_locality`. */
export type PetZone = { province: string | null; locality: string | null };

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

/** Any-of over the org's coverage rows. No rows at all covers nothing. */
export function orgCoversZone(areas: readonly CoverageArea[], zone: PetZone): boolean {
  return areas.some((area) => coverageAreaCoversZone(area, zone));
}
