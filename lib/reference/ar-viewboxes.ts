// Bounding boxes for major Argentine jurisdictions, used as soft priority
// hints (Nominatim viewbox + bounded=0) when forward-geocoding addresses
// reported by owners of pets in those jurisdictions.
//
// Format per Nominatim: [minLng, minLat, maxLng, maxLat] — i.e. the SW corner
// followed by the NE corner, longitudes first.
//
// Only a handful of high-traffic jurisdictions are listed; for everything else
// we fall through to countrycodes=ar only. Adding more is mechanical when the
// data shows it matters.

const PROVINCE_VIEWBOXES: Record<string, [number, number, number, number]> = {
  // CABA — the dense pedestrian-scale city. Bbox is the official limits of
  // the autonomous city (General Paz to the river). Keyed on the canonical
  // display name (PROVINCES[i].name); CHECK constraint on the column
  // enforces this since migration 0055.
  CABA: [-58.5316, -34.705, -58.3354, -34.5265],
  // Province of Buenos Aires (huge — covers GBA, Mar del Plata, La Plata,
  // and rural pampa). Useful for narrowing intra-province ambiguity.
  "Buenos Aires": [-63.4, -41.05, -56.6, -33.27],
  Córdoba: [-65.74, -35.0, -61.78, -29.5],
  "Santa Fe": [-63.5, -34.0, -59.6, -28.0],
  Mendoza: [-70.0, -37.6, -67.0, -31.9],
};

export function provinceViewbox(
  provinceName: string | null | undefined,
): [number, number, number, number] | null {
  if (!provinceName) return null;
  return PROVINCE_VIEWBOXES[provinceName] ?? null;
}
