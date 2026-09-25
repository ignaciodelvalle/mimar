// Where a bite HAPPENED, when the phone sent a map pin (M17 security review).
//
// PO RULE: a bite counts where it happened, not where the animal lives. Since
// M17 the app sends two answers to that question — the pin a person placed on
// the map, and the (province, locality, INDEC id) trio from the locality
// picker — and before this file the server wrote the trio and IGNORED the pin
// for routing. A pin in Córdoba next to codes for Buenos Aires filed the case
// in Buenos Aires; a pin with no codes fell back to the pet's HOME. Both route
// the case to the wrong authority.
//
// THE CHOICE, per case:
//
//   · PIN + TRIO → the trio is CHECKED against the pin with the resolver the
//     denuncia intakes already use (`coordinatesCorroborateJurisdiction`: the
//     province must be among the nearest catalogued localities, the locality
//     within 25 km or among the nearest three). A mismatch is REFUSED
//     (`bite_location_mismatch`), not corrected: both answers came from the
//     person, and only they know which one is wrong — silently picking one
//     would write a jurisdiction nobody chose into a record an authority acts on.
//   · PIN, NO TRIO → the jurisdiction is DERIVED from the pin: the web's own
//     derivation first (server-side reverse geocoding → canonical catalogue
//     pair, kept only if the pin corroborates it), else the nearest catalogued
//     locality. Never the pet's home when a pin says otherwise.
//   · NO PIN → unchanged: the trio if given, else the writer's fallback to the
//     animal's home jurisdiction ("no lo sé" is a real answer).

import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { nearestLocalities } from "@/lib/infra/ar-localidades";
import { reverseGeocode } from "@/lib/infra/geocoding";
import { coordinatesCorroborateJurisdiction } from "@/lib/infra/jurisdiction-from-text";
import { provinceByName } from "@/lib/reference/ar-provincias";

export type BiteJurisdiction =
  | { ok: true; province: string | null; locality: string | null }
  | { ok: false; code: "invalid_request" | "bite_location_mismatch" };

export async function resolveBiteJurisdiction(input: {
  provinceCode: string | null;
  localityName: string | null;
  localityIndecId: string | null;
  locationLat: number | null;
  locationLng: number | null;
}): Promise<BiteJurisdiction> {
  const point =
    input.locationLat !== null && input.locationLng !== null
      ? { lat: input.locationLat, lng: input.locationLng }
      : null;

  if (input.provinceCode !== null) {
    let normalised: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
    try {
      normalised = await normalizeLocationForWrite(
        {
          provinceCode: input.provinceCode,
          province: null,
          locality: input.localityName,
          localityIndecId: input.localityIndecId,
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
    } catch {
      // `strict` throws on a pair the INDEC catalogue does not hold: a request
      // problem, not an animal problem.
      return { ok: false, code: "invalid_request" };
    }
    if (point !== null && normalised.province !== null) {
      const agrees = await coordinatesCorroborateJurisdiction({
        province: normalised.province,
        locality: normalised.locality,
        localityId: normalised.localityId,
        lat: point.lat,
        lng: point.lng,
      });
      if (!agrees) return { ok: false, code: "bite_location_mismatch" };
    }
    return { ok: true, province: normalised.province, locality: normalised.locality };
  }

  if (point === null) return { ok: true, province: null, locality: null };
  return deriveFromPin(point);
}

/** The pin's own jurisdiction: reverse geocoding if it corroborates, else nearest. */
async function deriveFromPin(point: { lat: number; lng: number }): Promise<BiteJurisdiction> {
  const reversed = await reverseGeocode(point.lat, point.lng).catch(() => null);
  const code = provinceByName(reversed?.province ?? null)?.code ?? null;
  if (code !== null && reversed?.locality) {
    const pair = await canonicalPair(code, reversed.locality);
    if (pair.province !== null) {
      const agrees = await coordinatesCorroborateJurisdiction({
        province: pair.province,
        locality: pair.locality,
        localityId: pair.localityId,
        lat: point.lat,
        lng: point.lng,
      });
      if (agrees) return { ok: true, province: pair.province, locality: pair.locality };
    }
  }
  const [nearest] = await nearestLocalities({ ...point, limit: 1 });
  if (!nearest) return { ok: true, province: null, locality: null };
  const pair = await canonicalPair(nearest.provinceCode, nearest.localityName);
  return { ok: true, province: pair.province, locality: pair.locality };
}

async function canonicalPair(provinceCode: string, locality: string) {
  const normalised = await normalizeLocationForWrite(
    {
      provinceCode,
      province: null,
      locality,
      localityIndecId: null,
      lat: null,
      lng: null,
      address: null,
    },
    { locality: "soft" },
  );
  return {
    province: normalised.province,
    locality: normalised.locality,
    localityId: normalised.localityId,
  };
}
