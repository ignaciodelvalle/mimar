// A resolved place, as a map client is told it — the same shape for the app's
// `POST /api/v1/geocoding` and the web's reverse-geocoding actions
// (localidades-por-id B3/B6).
//
// A client gets the STATUS and, when nothing resolved to one row, the
// CANDIDATES a person could pick ("¿Es acá?"): the homonyms of an ambiguous
// name, or the rows near an unnamed pin, each labelled with its department so
// two Mechitas read as two places. The catalogue uuid stays on the server; a
// pick travels back as the INDEC id (or, for a CABA barrio, which has none, as
// its name — unique inside CABA).

import type { GeocodingPlaceV1 } from "@dim/contract/api";

import type { ResolvedPlace } from "@/lib/place/resolve-place";
import { provinceByCode } from "@/lib/reference/ar-provincias";

export function placeForClient(place: ResolvedPlace | null): GeocodingPlaceV1 {
  if (!place) return { status: "unresolved", candidates: [] };
  return {
    status: place.status,
    candidates: place.candidates.map((c) => ({
      provinceCode: c.provinceCode,
      provinceName: provinceByCode(c.provinceCode)?.name ?? c.provinceCode,
      localityName: c.localityName,
      localityIndecId: c.indecId,
      departmentName: c.departmentName,
    })),
  };
}
