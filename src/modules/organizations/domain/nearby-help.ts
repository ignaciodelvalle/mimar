// The finder's plan-B list — the pure rules (P4; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §4).
//
// Three things a finder's place must never become: stored, logged, or precise.
// This file owns the third. Both ends of every distance are snapped to a
// COARSE_GRID_DEGREES grid before anything is measured, and the distance is
// only ever shown as a coarse bucket. The org end matters as much as the
// finder's: a clinic's coordinates are withheld by the public directory's rule
// (migration 0283), and an exact distance from points of one's choosing would
// trilaterate them.
//
// ZERO server imports: the page components render the types and labels below.

/** ~1.1 km of latitude; ~0.9 km of longitude at Buenos Aires. */
export const COARSE_GRID_DEGREES = 0.01;

/** How far an organization may be and still be "nearby". */
export const NEARBY_RADIUS_KM = 50;
/** Receiving organizations shown, nearest first. */
export const RECEIVER_LIMIT = 5;
/** Vets shown — the short list for an urgent case, above the receivers. */
export const VET_LIMIT = 3;

export type GeoPoint = { lat: number; lng: number };

/** Argentina's bounding box, Antarctic sector excluded — a sanity bound, not a border. */
const AR_BOUNDS = { minLat: -56, maxLat: -21, minLng: -74, maxLng: -53 };

export function isPlausibleArPoint(p: GeoPoint): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= AR_BOUNDS.minLat &&
    p.lat <= AR_BOUNDS.maxLat &&
    p.lng >= AR_BOUNDS.minLng &&
    p.lng <= AR_BOUNDS.maxLng
  );
}

function snap(value: number): number {
  // Two decimals IS the 0.01° grid; toFixed avoids 0.1 + 0.2 residue.
  return Number((Math.round(value / COARSE_GRID_DEGREES) * COARSE_GRID_DEGREES).toFixed(2));
}

/** The point on the coarse grid. The ONLY form a finder's place is queried in. */
export function coarsenPoint(p: GeoPoint): GeoPoint {
  return { lat: snap(p.lat), lng: snap(p.lng) };
}

/**
 * The distance as a finder reads it. Below 2 km the grid's own error is the
 * same size as the number, so it is not shown; up to 10 km to the kilometre;
 * beyond that to the nearest 5.
 */
export function distanceLabel(km: number): string {
  if (km < 2) return "a menos de 2 km";
  if (km < 10) return `a unos ${Math.round(km)} km`;
  return `a unos ${Math.round(km / 5) * 5} km`;
}

/**
 * Nearest first, within the radius, at most `limit`. Ties (the coarse grid
 * makes them common) break by name so the order is stable between requests.
 */
export function rankNearby<T extends { distanceKm: number; displayName: string }>(
  rows: ReadonlyArray<T>,
  limit: number,
  radiusKm: number = NEARBY_RADIUS_KM,
): T[] {
  return rows
    .filter((r) => Number.isFinite(r.distanceKm) && r.distanceKm <= radiusKm)
    .slice()
    .sort((a, b) => a.distanceKm - b.distanceKm || a.displayName.localeCompare(b.displayName, "es"))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// What crosses to the browser — the public-safe projection
// ---------------------------------------------------------------------------

/**
 * One organization on the finder's list. EXACTLY these keys — the test pins
 * the set. No coordinates, no distance in km, no account email or phone, no
 * CUIT, no legal name, no member.
 */
export type NearbyOrgCard = {
  /** Present only when the org is listed in the public directory (/refugios). */
  profileHref: string | null;
  displayName: string;
  typeLabel: string;
  locality: string | null;
  distanceLabel: string;
  /** Receivers only — vets come from the directory and carry no status. */
  capacityLabel: string | null;
  /** The channel the org chose to publish (receivers only). */
  contact: { label: string; value: string; href: string | null } | null;
  hours: string | null;
};

export const NEARBY_ORG_CARD_KEYS: ReadonlyArray<keyof NearbyOrgCard> = [
  "profileHref",
  "displayName",
  "typeLabel",
  "locality",
  "distanceLabel",
  "capacityLabel",
  "contact",
  "hours",
];

/** When nobody receives nearby: the jurisdiction cascade's answer. */
export type NearbyFallback =
  /** An opted-in municipal service of the place's locality, else province. */
  | { kind: "municipal_service"; card: NearbyOrgCard }
  /** No service on miMAR: the governing municipality's NAME, from the official reference. */
  | { kind: "local_government"; name: string }
  | { kind: "general" };

export type NearbyHelp = {
  /** Nearest vets — filled only when asked (urgent condition, chip check). */
  vets: NearbyOrgCard[];
  receivers: NearbyOrgCard[];
  /** Set only when `receivers` is empty. */
  fallback: NearbyFallback | null;
  /** The place's locality, for the /perdidas link. Names only. */
  place: { province: string | null; locality: string | null } | null;
};
