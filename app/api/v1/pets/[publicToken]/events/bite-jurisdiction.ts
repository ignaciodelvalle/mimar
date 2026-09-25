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
// The place is resolved by the resolver every report uses
// (lib/place/reported-place.ts, localidades-por-id A4). THE CHOICE, per case:
//
//   · PIN + TRIO → the trio is CHECKED against the pin
//     (`coordinatesCorroborateJurisdiction`: the province must be among the
//     nearest catalogued localities, the locality within 25 km or among the
//     nearest three). A mismatch is REFUSED (`bite_location_mismatch`), not
//     corrected: both answers came from the person, and only they know which
//     one is wrong — silently picking one would write a jurisdiction nobody
//     chose into a record an authority acts on.
//   · PIN, NO TRIO → derived from the pin: a reverse-geocoded NAME that names
//     one catalogue row and that the pin corroborates. Otherwise the bite is
//     PROVINCE-level — the nearest catalogued centroid is NOT a locality (it
//     used to be: a border pin sits nearer the neighbour's centre, and that
//     picked the neighbour's authority and rabies rule). Never the pet's home.
//   · A NAME TWO LOCALITIES OF ONE PROVINCE SHARE, with no id, is a
//     province-level bite — never either homonym. (The contract refuses a
//     trio without its id, so this is the belt behind that brace.)
//   · NO PIN → the trio if given, else the writer's fallback to the animal's
//     home jurisdiction ("no lo sé" is a real answer).

import { JurisdictionValidationError } from "@/lib/domain/location-normalize";
import type { EventPlace } from "@/lib/events/place-payload";
import { toEventPlaceOrNull } from "@/lib/place/event-place";
import { type ReportedPlace, resolveReportedPlace } from "@/lib/place/reported-place";

export type BiteJurisdiction =
  | {
      ok: true;
      province: string | null;
      locality: string | null;
      /** `ar_localities` id of the one resolved row, else null. */
      localityId: string | null;
      /** As entered and as resolved, for the incident's payload (A8); null when nothing was entered. */
      place: EventPlace | null;
    }
  | { ok: false; code: "invalid_request" | "bite_location_mismatch" };

export async function resolveBiteJurisdiction(input: {
  provinceCode: string | null;
  localityName: string | null;
  localityIndecId: string | null;
  /** The person picked the locality from the map's candidates (B6). */
  localityPicked?: boolean;
  locationLat: number | null;
  locationLng: number | null;
}): Promise<BiteJurisdiction> {
  let place: ReportedPlace;
  try {
    place = await resolveReportedPlace(
      {
        // The CODE is what a client may assert; the display name is the
        // catalogue's to decide.
        provinceCode: input.provinceCode,
        province: null,
        locality: input.localityName,
        localityIndecId: input.localityIndecId,
        ...(input.localityPicked === true ? { localityPicked: true } : {}),
        lat: input.locationLat,
        lng: input.locationLng,
        address: null,
      },
      { pair: "strict" },
    );
  } catch (err) {
    // `strict` throws on a pair the INDEC catalogue does not hold: a request
    // problem, not an animal problem.
    if (err instanceof JurisdictionValidationError) return { ok: false, code: "invalid_request" };
    throw err;
  }

  if (place.mismatch) return { ok: false, code: "bite_location_mismatch" };
  const eventPlace = toEventPlaceOrNull(place);
  if (place.province === null) {
    return { ok: true, province: null, locality: null, localityId: null, place: eventPlace };
  }
  return {
    ok: true,
    province: place.province,
    locality: place.locality,
    localityId: place.localityId,
    place: eventPlace,
  };
}
