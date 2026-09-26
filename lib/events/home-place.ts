// The pet's home at event time, as an event `place` (localidades-por-id D3).
//
// A few events are ABOUT the pet's home rather than about somewhere a person
// typed: an outbreak signal is counted where the animal lives, and its payload
// has always snapshotted the home pair (`pet_jurisdiction_*`). This builds the
// matching `place` from the SAME snapshot the writer already holds — the pet
// row read in the event's transaction — so the id travels with the names and
// nothing re-reads the pet later.
//
//   entered  — the home names as stored (no INDEC id: nobody typed one).
//   resolved — the home's catalogue row, with the method that decided it on
//              the pet (the id itself when none was recorded), or null when
//              the home names no single row. Never a homonym picked by name.
//
// `undefined` when the caller holds no id snapshot at all (an unwired writer):
// the event then carries no place rather than a false 'unresolved'.

import { PLACE_METHODS, type PlaceMethod } from "@/lib/domain/place";
import type { EventPlace } from "@/lib/events/place-payload";
import { provinceByName } from "@/lib/reference/ar-provincias";

export type HomePlaceSnapshot = {
  province: string | null;
  locality: string | null;
  /** ABSENT = no snapshot; null = the home names no single catalogue row. */
  localityId?: string | null;
  placeMethod?: string | null;
};

function methodOf(recorded: string | null | undefined): PlaceMethod {
  const known = PLACE_METHODS.find((m) => m === recorded);
  return known && known !== "unresolved" ? known : "catalogue_id";
}

export function homePlace(home: HomePlaceSnapshot): EventPlace | undefined {
  if (home.localityId === undefined) return undefined;
  const entered = { province: home.province, locality: home.locality, indec_id: null };
  if (home.localityId === null) return { entered, resolved: null };
  const provinceCode = provinceByName(home.province)?.code;
  // A row with no readable province cannot be stated honestly: no place.
  if (!provinceCode) return undefined;
  return {
    entered,
    resolved: {
      locality_id: home.localityId,
      province_code: provinceCode,
      method: methodOf(home.placeMethod),
    },
  };
}
