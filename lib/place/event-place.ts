// A resolved report place → the `place` object its event payload keeps.
//
// localidades-por-id A5/A8. See lib/events/place-payload.ts for what the object
// is and why it holds no point and no address.

import type { NormalizedLocation } from "@/lib/domain/location-normalize";
import type { LocationValue } from "@/lib/domain/location-value";
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
  const resolved =
    place.localityId && provinceCode
      ? { locality_id: place.localityId, province_code: provinceCode, method: place.method }
      : null;
  const candidates = resolved === null ? (place.candidateIds ?? []) : [];
  return {
    entered: {
      province: place.entered.province,
      locality: place.entered.locality,
      indec_id: place.entered.indecId,
    },
    resolved,
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

/**
 * The same object for a writer that resolved through the write gate
 * (`normalizeLocationForWrite`): `entered` is the LocationValue the form sent,
 * `resolved` the row the gate answered with and how. `null` when nothing was
 * entered — an event that says nothing about where records no place.
 */
export function eventPlaceFromGate(
  loc: LocationValue,
  normalized: NormalizedLocation,
): EventPlace | null {
  const enteredProvince = loc.provinceCode ?? loc.province ?? null;
  const enteredLocality = loc.locality ?? null;
  const indecId = loc.localityIndecId?.trim() || null;
  if (!enteredProvince && !enteredLocality && !indecId) return null;
  const provinceCode = provinceByName(normalized.province)?.code ?? null;
  return {
    entered: { province: enteredProvince, locality: enteredLocality, indec_id: indecId },
    resolved:
      normalized.localityId && provinceCode
        ? {
            locality_id: normalized.localityId,
            province_code: provinceCode,
            method: normalized.placeMethod,
          }
        : null,
  };
}
