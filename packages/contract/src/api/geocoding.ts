// What `POST /api/v1/geocoding` answers (M17). See `input/geocoding.ts`.

export const GEOCODING_PAYLOAD_VERSION = 1;

/**
 * The jurisdiction a point falls in, DERIVED ON THE SERVER the way the web's
 * map derives it: the geocoder's province name resolved to its ISO code, and
 * the locality resolved against the INDEC catalogue. `null` when the pair does
 * not resolve — the writers then fall back exactly as they do for a web form
 * with no locality. `localityIndecId` is `null` for rows the catalogue ships
 * without one (the CABA barrios).
 */
export type GeocodingJurisdictionV1 = {
  provinceCode: string;
  provinceName: string;
  localityName: string;
  localityIndecId: string | null;
};

export type GeocodingMatchV1 = {
  label: string;
  lat: number;
  lng: number;
  jurisdiction: GeocodingJurisdictionV1 | null;
};

export type GeocodingSearchV1 = {
  command: "search";
  version: typeof GEOCODING_PAYLOAD_VERSION;
  matches: GeocodingMatchV1[];
};

/** `label: null` = the geocoder has no address for that point (or was busy). */
export type GeocodingReverseV1 = {
  command: "reverse";
  version: typeof GEOCODING_PAYLOAD_VERSION;
  label: string | null;
  jurisdiction: GeocodingJurisdictionV1 | null;
};

export type GeocodingAckV1 = GeocodingSearchV1 | GeocodingReverseV1;
