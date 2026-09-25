// What `POST /api/v1/geocoding` answers (M17). See `input/geocoding.ts`.

export const GEOCODING_PAYLOAD_VERSION = 1;

/**
 * The jurisdiction a point falls in, DERIVED ON THE SERVER the way the web's
 * map derives it: the geocoder's province name resolved to its ISO code, and
 * the locality resolved against the INDEC catalogue to exactly ONE row (a name
 * two rows share is never settled here — see `place`). `null` when the pair
 * does not resolve — the writers then fall back exactly as they do for a web form
 * with no locality. `localityIndecId` is `null` for rows the catalogue ships
 * without one (the CABA barrios).
 */
export type GeocodingJurisdictionV1 = {
  provinceCode: string;
  provinceName: string;
  localityName: string;
  localityIndecId: string | null;
};

/**
 * How the server resolved the geocoder's answer against the catalogue
 * (localidades-por-id B3):
 *   - `resolved`: exactly one row — `jurisdiction` names it;
 *   - `ambiguous`: a name two or more rows of the province share (Mechita,
 *     partido Alberti and partido Bragado) — `jurisdiction` is null and the
 *     rows come back as `candidates`, labelled with their departments;
 *   - `unresolved`: nothing names one row — for a pin, the nearby rows come
 *     back as `candidates`, nearest first.
 * A client never picks a candidate for the person: it shows them ("¿Es acá?")
 * and sends the one the person chose, marked as picked.
 */
export type GeocodingPlaceStatusV1 = "resolved" | "ambiguous" | "unresolved";

/** A catalogue locality a person may pick. `localityIndecId` is null for CABA barrios. */
export type GeocodingCandidateV1 = {
  provinceCode: string;
  provinceName: string;
  localityName: string;
  localityIndecId: string | null;
  departmentName: string | null;
};

export type GeocodingPlaceV1 = {
  status: GeocodingPlaceStatusV1;
  candidates: GeocodingCandidateV1[];
};

export type GeocodingMatchV1 = {
  label: string;
  lat: number;
  lng: number;
  jurisdiction: GeocodingJurisdictionV1 | null;
  /** Optional for clients built before B3; the server always sends it. */
  place?: GeocodingPlaceV1;
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
  /** Optional for clients built before B3; the server always sends it. */
  place?: GeocodingPlaceV1;
};

export type GeocodingAckV1 = GeocodingSearchV1 | GeocodingReverseV1;
