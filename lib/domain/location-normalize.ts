// Location normalization gate — P2 of the location domain epic.
//
// normalizeLocationForWrite is the single write gate for all server actions
// that persist a LocationValue. It consolidates the scattered per-site calls to
// canonicalProvinceNameForStorage / resolveCanonicalJurisdiction /
// tryResolveCanonicalJurisdiction behind a single entry point whose opts
// preserve the SAME effective behavior each site had before P2.
//
// Design contract:
//  - "strict"  → resolveUniqueJurisdiction (throws JurisdictionValidationError,
//                including AMBIGUOUS_LOCALITY for a within-province homonym)
//  - "soft"    → tryResolveCanonicalJurisdiction (pass-through on miss; an
//                ambiguous name is stored at PROVINCE level, locality null)
//  - "none"    → canonicalProvinceNameForStorage only; raw locality passed through
//  - requireCoords: true → reject when lat/lng are absent or out-of-range.
//    Only pass for sites that already required coords before P2.
//  - coord range check (lat -90..90 / lng -180..180) is run whenever coords
//    are present, regardless of locality mode. This is the deliberate P2
//    hardening: previously only sighting/finder enforced range; now setPetLost
//    also does (see STEP 3 in the P2 spec).
//
// SAFETY NET: every option combination maps to what the caller already did.
// No new hard rejections are introduced unless the caller passes requireCoords.

import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import type { LocationValue } from "@/lib/domain/location-value";
import type { PlaceMethod } from "@/lib/domain/place";
import {
  JurisdictionValidationError,
  resolveCanonicalJurisdictionById,
  resolveUniqueJurisdiction,
  tryResolveCanonicalJurisdiction,
} from "@/lib/infra/jurisdiction-validation";

export type LocalityValidation = "strict" | "soft" | "none";

export type NormalizeOpts = {
  /**
   * Controls locality validation:
   * - "strict": resolveUniqueJurisdiction — throws on an unknown locality AND on
   *             a name that names two catalogue rows (AMBIGUOUS_LOCALITY).
   * - "soft":   tryResolveCanonicalJurisdiction — passes raw text on miss; an
   *             ambiguous name comes back with locality null (province-level).
   * - "none":   no locality lookup; raw locality is passed through as-is.
   *
   * REQUIRED, with no default (L0·1 of the locality plan, 2026-09-08). It used
   * to default to "none", which silently DISCARDS even a well-formed INDEC id a
   * client already resolved — so every call that forgot the option inherited the
   * weakest mode without anyone deciding it. Every production call already
   * passed the mode explicitly; making it mandatory turns each future "none"
   * into a written decision at the call site instead of an inherited silence.
   */
  locality: LocalityValidation;
  /**
   * When true, coords must be present AND in range.
   * Use only for sites that already rejected missing coords before P2.
   */
  requireCoords?: boolean;
};

export type NormalizedLocation = {
  /** Canonical display name for storage (e.g. "Buenos Aires", "CABA"). */
  province: string | null;
  /** Canonical locality name, raw locality, or null depending on opts. */
  locality: string | null;
  /**
   * true when the locality resolved against the INDEC catalog.
   * Always true for "strict" (throws on miss), true/false for "soft",
   * always false for "none".
   */
  localityCanonical: boolean;
  /**
   * ar_localities uuid PK when the locality resolved, else null. This is the
   * structural locality-attribution FK value (migration 0147) — write sites set
   * their pets/welfare/cases.localityId column from it. Null under "none" mode,
   * on a passthrough (province or locality absent), and on a "soft" miss.
   */
  localityId: string | null;
  /**
   * HOW the locality resolved (lib/domain/place.ts): `indec_id` when the id
   * decided it, `exact_name_unique` / `folded_name_unique` when the name named
   * exactly one row, `unresolved` for everything else — "none" mode, a
   * passthrough, a soft miss and an ambiguous name alike.
   */
  placeMethod: PlaceMethod;
  lat: number | null;
  lng: number | null;
  address: string | null;
};

/**
 * Coordinate range errors thrown by normalizeLocationForWrite when
 * requireCoords is true or when present coords are out of range.
 */
export class CoordError extends Error {
  readonly code: "COORD_REQUIRED" | "COORD_OUT_OF_RANGE";
  constructor(code: "COORD_REQUIRED" | "COORD_OUT_OF_RANGE", message: string) {
    super(message);
    this.name = "CoordError";
    this.code = code;
  }
}

/**
 * Single write gate for persisting location data from a {@link LocationValue}.
 *
 * @throws {JurisdictionValidationError} when locality="strict" and the
 *   (province, locality) pair is not in the INDEC catalog.
 * @throws {CoordError} when requireCoords=true and coords are absent, or when
 *   any present coords are outside WGS-84 range.
 */
export async function normalizeLocationForWrite(
  loc: LocationValue,
  opts: NormalizeOpts,
): Promise<NormalizedLocation> {
  const { locality: localityMode, requireCoords = false } = opts;

  // ── 1. Province canonicalization ──────────────────────────────────────────
  // Handles ISO code (e.g. "AR-C"), display name, and aliases.
  // Returns null when the input is empty or unresolvable.
  const province = canonicalProvinceNameForStorage(loc.provinceCode ?? loc.province ?? "");

  // ── 2. Coord validation ───────────────────────────────────────────────────
  const lat = loc.lat;
  const lng = loc.lng;
  assertCoords(lat, lng, requireCoords);

  // ── 3. Locality resolution ────────────────────────────────────────────────
  const rawLocality = loc.locality ?? "";

  // THE INDEC ID WINS WHEN THERE IS ONE (A2-alta-asentar-03).
  //
  // `localityByName` disambiguates a homonym by taking the alphabetically first
  // department (`.orderBy(departmentName).limit(1)` — its own comment says so),
  // and the INDEC catalogue ships 68 (province, name) collisions. So a person in
  // San Martín who was SHOWN two rows with different departments and tapped the
  // second one had their pet stored in the other San Martín. Jurisdiction decides
  // the responding authority, which PPP rules apply and where the animal counts
  // epidemiologically, and on a later move the registry answers
  // `move_same_locality` for a move that is not.
  //
  // The field existed on `LocationValue` from the start and NOTHING read it (14-4
  // in the jurisdiction review, still open). Every caller passed null, so the id
  // path is new behaviour for whoever starts sending one and a no-op for the rest.
  const indecId = loc.localityIndecId?.trim() || null;
  if (localityMode !== "none" && indecId) {
    const byId = await resolveByIndecId(indecId, province, localityMode);
    if (byId !== null) {
      return { ...byId, placeMethod: "indec_id", lat, lng, address: loc.address };
    }
  }

  if (localityMode === "strict") {
    if (province && rawLocality) {
      // Throws JurisdictionValidationError on an unknown (province, locality)
      // and on a NAME that names two catalogue rows in the province
      // (AMBIGUOUS_LOCALITY, localidades-por-id A9): a person who picked from
      // the catalogue can pick the row, and filing the pair under the
      // alphabetically first department is the defect this replaces. Callers
      // catch and map to their action error shape — same as before P2.
      const canonical = await resolveUniqueJurisdiction({
        rawProvince: province,
        rawLocality,
      });
      return {
        province: canonical.province.name,
        locality: canonical.locality.localityName,
        localityCanonical: true,
        localityId: canonical.locality.id,
        placeMethod: canonical.method,
        lat,
        lng,
        address: loc.address,
      };
    }
    // Province or locality absent — pass through without strict validation.
    return {
      province,
      locality: rawLocality || null,
      localityCanonical: false,
      localityId: null,
      placeMethod: "unresolved",
      lat,
      lng,
      address: loc.address,
    };
  }

  if (localityMode === "soft") {
    if (province && rawLocality) {
      const resolved = await tryResolveCanonicalJurisdiction({
        rawProvince: province,
        rawLocality,
      });
      if (resolved.ambiguous) {
        // A NAME TWO MUNICIPALITIES SHARE IS NOT A PLACE (localidades-por-id
        // A9). Soft must never block a report, and it must never pick a
        // homonym either. Keeping the raw name would be worse than it looks:
        // scope and routing still match by name, so "Mechita" would be read by
        // BOTH Mechitas' operators. With the locality NULL the row is exactly
        // what `jurisdictionPairClause` calls province-level — the province's
        // own authority sees it, neither municipality is widened. What the
        // person typed survives in the caller's own record of the entry.
        return {
          province: resolved.province || province,
          locality: null,
          localityCanonical: false,
          localityId: null,
          placeMethod: "unresolved",
          lat,
          lng,
          address: loc.address,
        };
      }
      return {
        province: resolved.province || province,
        locality: resolved.locality || rawLocality || null,
        localityCanonical: resolved.canonical,
        localityId: resolved.localityId,
        placeMethod: resolved.method,
        lat,
        lng,
        address: loc.address,
      };
    }
    return {
      province,
      locality: rawLocality || null,
      localityCanonical: false,
      localityId: null,
      placeMethod: "unresolved",
      lat,
      lng,
      address: loc.address,
    };
  }

  // "none": province canonicalization only; raw locality passed through.
  return {
    province,
    locality: rawLocality || null,
    localityCanonical: false,
    localityId: null,
    placeMethod: "unresolved",
    lat,
    lng,
    address: loc.address,
  };
}

/**
 * The coordinate rules, unchanged and moved out of the gate's body so the
 * locality branches read as the three cases they are.
 *
 * @throws {CoordError} when `requireCoords` and either half is absent or
 *   non-finite, or when PRESENT coords are outside WGS-84 range. The range check
 *   runs whenever coords exist, regardless of locality mode — the deliberate P2
 *   hardening (STEP 3 in the P2 spec).
 */
function assertCoords(lat: number | null, lng: number | null, requireCoords: boolean): void {
  if (requireCoords) {
    if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new CoordError("COORD_REQUIRED", "Coordenadas requeridas pero ausentes o inválidas.");
    }
  }
  if (lat !== null && lng !== null) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new CoordError("COORD_OUT_OF_RANGE", "La ubicación está fuera de rango.");
    }
  }
}

/**
 * The catalogue row an INDEC id names, or `null` when the caller should fall
 * back to the name path.
 *
 * Split out of `normalizeLocationForWrite` so the id branch's THREE outcomes are
 * readable in one place: resolved, refused (strict), or "let the name path try"
 * (soft). Returns the location half only; the caller owns the coordinates.
 *
 * @throws {JurisdictionValidationError} under `strict`, for an id the catalogue
 *   does not know or one whose province contradicts the claimed one.
 */
async function resolveByIndecId(
  indecId: string,
  province: string | null,
  localityMode: LocalityValidation,
): Promise<Pick<
  NormalizedLocation,
  "province" | "locality" | "localityCanonical" | "localityId"
> | null> {
  try {
    const canonical = await resolveCanonicalJurisdictionById({ indecId });
    // THE CLAIMED PROVINCE IS CROSS-CHECKED, not overruled. The id is the
    // authority for WHICH locality, but a body whose two halves disagree is a
    // broken or hostile client, and silently storing the id's province would let
    // a caller attribute a pet to a jurisdiction it never named.
    if (province && canonical.province.name !== province) {
      throw new JurisdictionValidationError(
        "INVALID_LOCALITY",
        `La localidad '${canonical.locality.localityName}' no pertenece a '${province}'.`,
      );
    }
    return {
      province: canonical.province.name,
      locality: canonical.locality.localityName,
      localityCanonical: true,
      localityId: canonical.locality.id,
    };
  } catch (err) {
    // "soft" means a locality this catalogue does not know is not a reason to
    // break the write, and that has to hold for a stale id exactly as it holds
    // for a stale name — hand the caller back to the name path. "strict"
    // refuses, because falling back there would resolve the NAME and land on the
    // alphabetically first department, which is what the id exists to replace.
    if (localityMode === "strict" || !(err instanceof JurisdictionValidationError)) throw err;
    return null;
  }
}

// Re-export for callers that need the error type without a separate import.
export { JurisdictionValidationError };
