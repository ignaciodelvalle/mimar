// A resolved report place → the `place` object its event payload keeps.
//
// localidades-por-id A5/A8. See lib/events/place-payload.ts for what the object
// is and why it holds no point and no address.

import type { EventPlace } from "@/lib/events/place-payload";
import type { ReportedPlace } from "@/lib/place/reported-place";
import { provinceByName } from "@/lib/reference/ar-provincias";

/**
 * The payload `place` of a report that may carry no place at all: `null` when
 * nothing was entered (a text-only update), so a note never records an empty
 * place as if one had been given.
 */
export function toEventPlaceOrNull(place: ReportedPlace): EventPlace | null {
  return place.unresolvedReason === "none_entered" ? null : toEventPlace(place);
}

export function toEventPlace(place: ReportedPlace): EventPlace {
  const provinceCode = provinceByName(place.province)?.code ?? null;
  return {
    entered: {
      province: place.entered.province,
      locality: place.entered.locality,
      indec_id: place.entered.indecId,
    },
    resolved:
      place.localityId && provinceCode
        ? { locality_id: place.localityId, province_code: provinceCode, method: place.method }
        : null,
  };
}
