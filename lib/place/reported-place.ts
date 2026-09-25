// Where a REPORTED event happened — a lost animal, a bite, a denuncia.
//
// localidades-por-id, stage A (A1 first; A2/A3/A4/A6 reuse it). Stage B folds
// this into `lib/place/resolve-place.ts`, the single resolver.
//
// A report carries up to two answers to "where": a (province, locality[, INDEC
// id]) pair — from a catalogue picker, or echoed from a reverse geocoder on the
// client — and a pin a person placed on a map. The rules, all in service of P1
// (never confuse places):
//
//   1. A pair resolves only to ONE catalogue row: the INDEC id wins; a name
//      counts only when it names exactly one row in its province. A name two
//      municipalities share (Mechita, Alberti and Bragado) is a PROVINCE-level
//      place — never either homonym, and never a refusal on a report.
//   2. With a pin, the pair must be corroborated by it
//      (`coordinatesCorroborateJurisdiction`, the same check the denuncia and
//      bite intakes use). A pair the pin contradicts keeps NO locality and is
//      flagged `mismatch`; its province survives only when the pin vouches for
//      it. Each caller decides what a mismatch means for it — the app's bite
//      API refuses it, a web map form re-derives from the pin.
//   3. A pin alone resolves only through a reverse-geocoded NAME that is unique
//      AND corroborated. The nearest catalogue centroid is never a locality
//      (the catalogue has centroids, not boundaries: a border pin sits nearer
//      the neighbour's centre all the time). Without a locality the place is
//      province-level, and the province itself is kept only when the geocoder's
//      province is corroborated, or every nearby catalogued locality lies in
//      the same province.
//   4. Nothing here ever reads the pet's home. A caller that has no place gets
//      `none_entered` and decides its own fallback. A pin that names no
//      province is still a place: UNRESOLVED, with the nearby catalogue
//      localities kept as `candidateIds` for the unresolved queue — never a
//      reason to use the home pair (stage A review, BLOCKER 2).

import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import {
  JurisdictionValidationError,
  type NormalizedLocation,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import type { LocationValue } from "@/lib/domain/location-value";
import type { PlaceMethod } from "@/lib/domain/place";
import { nearestLocalities } from "@/lib/infra/ar-localidades";
import { reverseGeocode } from "@/lib/infra/geocoding";
import { coordinatesCorroborateJurisdiction } from "@/lib/infra/jurisdiction-from-text";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

/** Why a place did not resolve to one catalogue row. */
export type UnresolvedReason =
  /** No pair and no pin: the report said nothing about where. */
  | "none_entered"
  /** The name names two or more rows in its province. */
  | "ambiguous"
  /** The catalogue does not know the name in that province (raw text kept). */
  | "not_in_catalogue"
  /** Only a province was given. */
  | "no_locality"
  /** The pin contradicts the pair. */
  | "pin_disagrees"
  /** A pin alone, and no unique corroborated name for it. */
  | "pin_only";

/** What the person or client GAVE, before any resolution (P2). */
export type EnteredPlace = {
  province: string | null;
  locality: string | null;
  indecId: string | null;
};

export type ReportedPlace = {
  /** Canonical province display name, or null when nothing honest names one. */
  province: string | null;
  /**
   * The catalogue name of the ONE resolved row; the raw text of a name the
   * catalogue does not know (`not_in_catalogue`); otherwise null — a
   * province-level place.
   */
  locality: string | null;
  /** `ar_localities` uuid of the one resolved row, else null. */
  localityId: string | null;
  method: PlaceMethod;
  unresolvedReason: UnresolvedReason | null;
  /** True when a pin was given and it contradicts the pair. */
  mismatch: boolean;
  entered: EnteredPlace;
  /**
   * Catalogue localities the POINT suggests, nearest first, when nothing
   * resolved — kept for the unresolved queue, never chosen. Empty otherwise.
   */
  candidateIds: string[];
};

type Point = { lat: number; lng: number };

const NEAREST_FOR_PROVINCE = 10;
/** How many point-derived candidates an unresolved pin keeps. */
const CANDIDATES_KEPT = 5;

/**
 * Resolve a reported place from its pair and, when present, its pin.
 *
 * @param opts.pair "strict" when the pair came from a catalogue picker, so a
 *   locality the catalogue does not know is a malformed request (throws
 *   JurisdictionValidationError); "soft" when the report must never be blocked.
 *   An AMBIGUOUS name is province-level under both — asking again is the
 *   picker's job, not the report's.
 */
export async function resolveReportedPlace(
  loc: LocationValue,
  opts: { pair: "strict" | "soft" },
): Promise<ReportedPlace> {
  const entered = enteredOf(loc);
  const point = pointOf(loc);

  if (!entered.province?.trim()) {
    if (point) return resolvePinPlace(point, entered);
    return unresolved(null, "none_entered", entered);
  }

  let normalized: NormalizedLocation;
  try {
    normalized = await normalizeLocationForWrite(
      { ...loc, lat: null, lng: null },
      { locality: opts.pair },
    );
  } catch (err) {
    if (err instanceof JurisdictionValidationError && err.code === "AMBIGUOUS_LOCALITY") {
      const province = canonicalProvinceNameForStorage(entered.province);
      return checkAgainstPin(unresolved(province, "ambiguous", entered), point);
    }
    throw err;
  }

  const place = fromNormalized(normalized, entered);
  return checkAgainstPin(place, point);
}

/**
 * THE PIN WINS A DISAGREEMENT. For the web's map forms the pair is the
 * client's reverse geocode of the SAME pin, so when the two disagree the pin —
 * the thing the person actually placed — is re-read on the server. The app's
 * lost report takes the same rule (`pair: "strict"`, its pair comes from the
 * catalogue picker) so that the same pin files the same case from either door
 * (localidades-por-id A3, "same pin, same unit, any channel").
 */
export async function resolveMapFormPlace(
  loc: LocationValue,
  opts: { pair: "strict" | "soft" } = { pair: "soft" },
): Promise<ReportedPlace> {
  const place = await resolveReportedPlace(loc, opts);
  const point = pointOf(loc);
  if (place.mismatch && point) return resolvePinPlace(point, place.entered);
  return place;
}

/** A pin and nothing else — rule 3 of the header. */
export async function resolvePinPlace(
  point: Point,
  entered: EnteredPlace = { province: null, locality: null, indecId: null },
): Promise<ReportedPlace> {
  const reversed = await reverseGeocode(point.lat, point.lng).catch(() => null);
  const geocodedCode = provinceByName(reversed?.province ?? null)?.code ?? null;

  if (geocodedCode && reversed?.locality) {
    const normalized = await normalizeLocationForWrite(
      {
        provinceCode: geocodedCode,
        province: null,
        locality: reversed.locality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "soft" },
    );
    if (normalized.province && normalized.localityId) {
      const agrees = await coordinatesCorroborateJurisdiction({
        province: normalized.province,
        locality: normalized.locality,
        localityId: normalized.localityId,
        lat: point.lat,
        lng: point.lng,
      });
      if (agrees) {
        return {
          province: normalized.province,
          locality: normalized.locality,
          localityId: normalized.localityId,
          method: "geocode_unique",
          unresolvedReason: null,
          mismatch: false,
          entered,
          candidateIds: [],
        };
      }
    }
  }

  const near = await nearestLocalities({ ...point, limit: NEAREST_FOR_PROVINCE });
  return {
    ...unresolved(await provinceOfPin(point, geocodedCode, near), "pin_only", entered),
    candidateIds: near.slice(0, CANDIDATES_KEPT).map((n) => n.id),
  };
}

// ---------------------------------------------------------------------------

function enteredOf(loc: LocationValue): EnteredPlace {
  return {
    province: loc.provinceCode ?? loc.province ?? null,
    locality: loc.locality ?? null,
    indecId: loc.localityIndecId?.trim() || null,
  };
}

function pointOf(loc: LocationValue): Point | null {
  return loc.lat !== null && loc.lng !== null ? { lat: loc.lat, lng: loc.lng } : null;
}

function unresolved(
  province: string | null,
  reason: UnresolvedReason,
  entered: EnteredPlace,
): ReportedPlace {
  return {
    province,
    locality: null,
    localityId: null,
    method: "unresolved",
    unresolvedReason: reason,
    mismatch: false,
    entered,
    candidateIds: [],
  };
}

function fromNormalized(n: NormalizedLocation, entered: EnteredPlace): ReportedPlace {
  if (n.localityId) {
    return {
      province: n.province,
      locality: n.locality,
      localityId: n.localityId,
      method: n.placeMethod,
      unresolvedReason: null,
      mismatch: false,
      entered,
      candidateIds: [],
    };
  }
  const typed = entered.locality?.trim() ?? "";
  // The gate answers an ambiguous soft name with NO locality; a name it does
  // not know comes back as the raw text. Those are the two ways a typed
  // locality can fail to resolve, and they mean different things.
  const reason: UnresolvedReason =
    typed === "" ? "no_locality" : n.locality === null ? "ambiguous" : "not_in_catalogue";
  return { ...unresolved(n.province, reason, entered), locality: n.locality };
}

/** Rule 2: a pin that contradicts the pair leaves no locality standing. */
async function checkAgainstPin(place: ReportedPlace, point: Point | null): Promise<ReportedPlace> {
  if (!point || !place.province) return place;

  const agrees = await coordinatesCorroborateJurisdiction({
    province: place.province,
    // Only a RESOLVED row can be measured against the pin; an unresolved
    // place is checked at the province it claims.
    locality: place.localityId ? place.locality : null,
    localityId: place.localityId,
    lat: point.lat,
    lng: point.lng,
  });
  if (agrees) return place;

  const provinceAgrees = place.localityId
    ? await coordinatesCorroborateJurisdiction({
        province: place.province,
        locality: null,
        localityId: null,
        lat: point.lat,
        lng: point.lng,
      })
    : false;
  return {
    ...unresolved(provinceAgrees ? place.province : null, "pin_disagrees", place.entered),
    mismatch: true,
  };
}

/**
 * The province a pin is in, when that can be said honestly: the geocoder's
 * province if the coordinates corroborate it, else the one province every
 * nearby catalogued locality shares. Near a border neither holds, and the
 * answer is null.
 */
async function provinceOfPin(
  point: Point,
  geocodedCode: string | null,
  near: Awaited<ReturnType<typeof nearestLocalities>>,
): Promise<string | null> {
  if (geocodedCode) {
    const name = provinceByCode(geocodedCode)?.name ?? null;
    if (
      name &&
      (await coordinatesCorroborateJurisdiction({
        province: name,
        locality: null,
        localityId: null,
        lat: point.lat,
        lng: point.lng,
      }))
    ) {
      return name;
    }
  }
  const codes = new Set(near.map((n) => n.provinceCode));
  if (codes.size !== 1) return null;
  const [code] = codes;
  return provinceByCode(code)?.name ?? null;
}
