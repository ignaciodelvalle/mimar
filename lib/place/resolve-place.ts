// THE place resolver — localidades-por-id B3.
//
// Every "which catalogue row is this place?" question has the same answer
// shape and the same order, whoever asks it (a writer, the geocoding door, the
// "¿Es acá?" picker, a backfill). The order is the design's:
//
//   1. An explicit id. The INDEC id a client sent, or the `ar_localities` uuid
//      inside the server (CABA barrios have no INDEC id). It must lie in the
//      province it came with: an id from another province is not a place in
//      this one. A stale id (the catalogue no longer has it) falls to the name.
//   2. The exact catalogue name, when it names ONE live row of the province.
//   3. An accent/case/punctuation variant of it, under the same condition.
//   4. A pin: its reverse-geocoded name through 2/3, accepted only when the
//      pin corroborates that row (the catalogue has centroids, not
//      boundaries — a pin alone never names a locality).
//   5. UNRESOLVED.
//
// Three answers, and every consumer passes the distinction on:
//   RESOLVED   exactly one row, and how it was reached (lib/domain/place.ts);
//   AMBIGUOUS  a name two or more rows of the province share (Mechita, partido
//              Alberti and partido Bragado). Neither is chosen; both come back
//              as candidates, labelled with their departments, for a person to
//              pick from (design addendum #1 — "¿Es acá?", method user_picked);
//   UNRESOLVED nothing names one row. A pin keeps the nearby rows as
//              candidates — suggestions for a person or the unresolved queue,
//              never a resolution.
//
// P1, by construction: there is no path that picks among homonyms, and none
// that turns the nearest centroid into a locality. The resolver never throws on
// a place a person entered; a caller that must refuse (a catalogue picker that
// sent a malformed pair) decides that from the answer.
//
// `lib/place/` is where name→row lookups live (lint:place-resolver freezes the
// callers outside it); `reported-place.ts` is the report policy on top of it.

import type { PlaceMethod } from "@/lib/domain/place";
import {
  type Locality,
  localitiesByIds,
  localitiesByName,
  localityById,
  localityByIndecId,
  nearestLocalities,
} from "@/lib/infra/ar-localidades";
import { reverseGeocode } from "@/lib/infra/geocoding";
import { coordinatesCorroborateJurisdiction } from "@/lib/infra/jurisdiction-from-text";
import { type ProvinceCode, provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

export type PlaceStatus = "resolved" | "ambiguous" | "unresolved";

export type PlaceUnresolvedReason =
  /** Nothing entered: no province, no locality, no pin. */
  | "none_entered"
  /** A province and no locality. */
  | "no_locality"
  /** The name names two or more rows of the province. */
  | "ambiguous"
  /** The catalogue does not know the name in that province. */
  | "not_in_catalogue"
  /** The id names a row of another province. */
  | "id_outside_province"
  /** A pin with no unique corroborated name. */
  | "pin_only";

/** A catalogue row a person could pick. `indecId` is null for CABA barrios. */
export type PlaceCandidate = {
  localityId: string;
  indecId: string | null;
  provinceCode: string;
  localityName: string;
  departmentName: string | null;
};

export type PlaceQuery = {
  /** Province NAME (any alias `provinceByName` accepts) or ISO code. */
  province: string | null;
  locality: string | null;
  /** The INDEC id a client sent. */
  indecId?: string | null;
  /** The `ar_localities` uuid — server-internal, never taken from a client. */
  localityId?: string | null;
  /** The person picked the id from the candidates ("¿Es acá?"). */
  picked?: boolean;
  point?: { lat: number; lng: number } | null;
};

export type ResolvedPlace = {
  status: PlaceStatus;
  /** Null only when resolved. */
  reason: PlaceUnresolvedReason | null;
  provinceCode: string | null;
  /** Canonical province display name. */
  province: string | null;
  /** The catalogue name of the ONE resolved row, else null. */
  locality: string | null;
  localityId: string | null;
  /** The resolved row's INDEC id (null for CABA barrios, and when unresolved). */
  indecId: string | null;
  method: PlaceMethod;
  /** Homonyms (ambiguous) or nearby rows (a pin); empty when resolved. */
  candidates: PlaceCandidate[];
};

/** How many nearby rows an unresolved pin offers. */
export const PIN_CANDIDATES = 5;
/** How many nearby rows decide which province a pin is in. */
const NEAREST_FOR_PROVINCE = 10;

export async function resolvePlace(query: PlaceQuery): Promise<ResolvedPlace> {
  const province = provinceByCode(query.province) ?? provinceByName(query.province);

  // 1. An explicit id.
  const byId = await rowById(query);
  if (byId) {
    if (province && byId.provinceCode !== province.code) {
      return unresolved(province, "id_outside_province");
    }
    const method: PlaceMethod = query.picked
      ? "user_picked"
      : query.localityId
        ? "catalogue_id"
        : "indec_id";
    return resolved(byId, method);
  }

  // 2-3. A name. What a person typed is answered as typed: a pin never
  // overrides it here (the report policy on top decides what a contradicting
  // pin means — lib/place/reported-place.ts).
  const name = query.locality?.trim() ?? "";
  if (province && name) return resolveName(province.code, name);

  // 4. A pin, when the pair named no locality.
  if (query.point) return resolvePin(query.point);
  if (!province) return unresolved(null, "none_entered");
  return unresolved(province, "no_locality");
}

/**
 * A (province, name) pair — steps 2 and 3. Exported for the geocoding door,
 * which asks exactly this about a geocoder's answer.
 */
export async function resolveName(provinceCode: string, name: string): Promise<ResolvedPlace> {
  const province = provinceByCode(provinceCode);
  if (!province) return unresolved(null, "none_entered");
  const rows = await localitiesByName(province.code as ProvinceCode, name);
  if (rows.length === 1) {
    const [only] = rows;
    const method: PlaceMethod =
      only.localityName === name.trim() ? "exact_name_unique" : "folded_name_unique";
    return resolved(only, method);
  }
  if (rows.length > 1) {
    return {
      ...unresolved(province, "ambiguous"),
      status: "ambiguous",
      candidates: rows.map(candidateOf),
    };
  }
  return unresolved(province, "not_in_catalogue");
}

// ---------------------------------------------------------------------------

type ProvinceRow = NonNullable<ReturnType<typeof provinceByCode>>;

async function rowById(query: PlaceQuery): Promise<Locality | null> {
  const uuid = query.localityId?.trim();
  const byUuid = uuid ? await localityById(uuid) : null;
  if (byUuid) return byUuid;
  const indecId = query.indecId?.trim();
  return indecId ? localityByIndecId(indecId) : null;
}

async function resolvePin(point: { lat: number; lng: number }): Promise<ResolvedPlace> {
  const reversed = await reverseGeocode(point.lat, point.lng).catch(() => null);
  return resolveGeocodedPin(point, reversed);
}

/**
 * Step 4 for a caller that already holds the reverse geocoder's answer for the
 * pin (the geocoding door spends its own rate-limited call): the geocoded name
 * through steps 2/3, accepted only when the pin corroborates the province and
 * the row. Otherwise UNRESOLVED with the nearby rows as candidates.
 */
export async function resolveGeocodedPin(
  point: { lat: number; lng: number },
  reversed: { province: string | null; locality: string | null } | null,
): Promise<ResolvedPlace> {
  const geocoded = provinceByName(reversed?.province ?? null);
  const provinceHolds =
    geocoded !== null &&
    (await coordinatesCorroborateJurisdiction({
      province: geocoded.name,
      locality: null,
      localityId: null,
      lat: point.lat,
      lng: point.lng,
    }));

  if (geocoded && provinceHolds && reversed?.locality) {
    const byName = await resolveName(geocoded.code, reversed.locality);
    if (byName.status === "ambiguous") return byName;
    if (byName.status === "resolved" && byName.localityId) {
      const agrees = await coordinatesCorroborateJurisdiction({
        province: geocoded.name,
        locality: byName.locality,
        localityId: byName.localityId,
        lat: point.lat,
        lng: point.lng,
      });
      if (agrees) return { ...byName, method: "geocode_unique" };
    }
  }

  const near = await nearestLocalities({ ...point, limit: NEAREST_FOR_PROVINCE });
  const codes = new Set(near.map((n) => n.provinceCode));
  const pinProvince =
    geocoded && provinceHolds ? geocoded : codes.size === 1 ? provinceByCode([...codes][0]) : null;
  return {
    ...unresolved(pinProvince, "pin_only"),
    candidates: await candidatesByIds(near.slice(0, PIN_CANDIDATES).map((n) => n.id)),
  };
}

/** Candidate rows for `ids`, in the order given (nearest first). */
async function candidatesByIds(ids: string[]): Promise<PlaceCandidate[]> {
  const byId = new Map((await localitiesByIds(ids)).map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [candidateOf(r)] : [];
  });
}

function candidateOf(row: Locality): PlaceCandidate {
  return {
    localityId: row.id,
    indecId: row.indecId,
    provinceCode: row.provinceCode,
    localityName: row.localityName,
    departmentName: row.departmentName,
  };
}

function resolved(row: Locality, method: PlaceMethod): ResolvedPlace {
  const province = provinceByCode(row.provinceCode);
  return {
    status: "resolved",
    reason: null,
    provinceCode: row.provinceCode,
    province: province?.name ?? null,
    locality: row.localityName,
    localityId: row.id,
    indecId: row.indecId,
    method,
    candidates: [],
  };
}

function unresolved(province: ProvinceRow | null, reason: PlaceUnresolvedReason): ResolvedPlace {
  return {
    status: "unresolved",
    reason,
    provinceCode: province?.code ?? null,
    province: province?.name ?? null,
    locality: null,
    localityId: null,
    indecId: null,
    method: "unresolved",
    candidates: [],
  };
}
