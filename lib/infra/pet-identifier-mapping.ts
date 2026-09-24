// Mapping helpers between the canonical pet_identifications fields and the
// legacy pets.* column shapes.
//
// Writers (microchip-use-case.ts, backfill 0082) map legacy → canonical using
// chipImplantSiteFromLocation() in lib/domain/microchip-implant-site.ts.
// This module provides the INVERSE direction so readers can convert canonical
// rows back to the same field format that event-projections (lib/projections/
// pet-microchip.ts, pet-tattoo.ts) output, enabling apples-to-apples
// comparison in the re-derivation harness.
//
// IMPORTANT: the mapping is lossy in one direction. The legacy
// `pets.microchipLocation` stored arbitrary free-text strings from form inputs
// (e.g. "interscapular_left", "interscapular_right", "interscapular",
// "neck_left", "neck_right", or anything else the user typed). The canonical
// `pet_identifications.implantationSite` stores the 5-value enum produced by
// chipImplantSiteFromLocation(). The inverse cannot recover the original
// free-text form value — it can only produce the canonical enum value.
//
// The projections (replayPetMicrochip) read the event payload's
// `location_on_body` field which is also the raw form value. So after
// ARCH-Q the comparison for `microchipLocation` becomes:
//   stored  = implantationSiteToMicrochipLocation(canonical.implantationSite)
//   derived = replayPetMicrochip events output (raw location_on_body)
//
// These may differ if the raw location_on_body was a variant like
// "interscapular_right" (maps to "interescapular") while canonical only stored
// "interescapular". The harness uses "strict" comparison, so this would
// surface as drift even when the canonical data is correct.
//
// Resolution: for `microchipLocation` the harness should compare both sides
// AFTER normalizing through chipImplantSiteFromLocation — i.e. also normalize
// the derived value. The harness handles this by using a dedicated compare
// kind "implantSite" for that column.

import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";

/**
 * Convert a canonical implantation_site enum value back to the
 * pets.microchip_location free-text value that the writer stored. Since the
 * writer always passes the raw location through chipImplantSiteFromLocation()
 * before storing in pet_identifications.implantation_site, the inverse is:
 * we just return the canonical value as-is and normalize the derived side too.
 *
 * For the harness comparison the meaningful operation is:
 *   normalize(canonical.implantationSite) vs normalize(projection.microchipLocation)
 * where normalize = chipImplantSiteFromLocation.
 *
 * This function provides the canonical → normalized form (identity for valid
 * enum values since they are already normalized).
 */
export function implantationSiteToMicrochipLocation(
  implantationSite: string | null,
): string | null {
  // The canonical enum values are already the output of chipImplantSiteFromLocation,
  // so they are their own normalized form. Return as-is.
  return implantationSite;
}

/**
 * Normalize a microchipLocation value (either from a projection's event
 * payload or a canonical implantation_site) to the canonical enum form so
 * both sides of the harness comparison speak the same language.
 *
 * Delegates to chipImplantSiteFromLocation which handles all legacy aliases.
 * Returns null for null/empty.
 */
export function normalizeMicrochipLocation(location: string | null): string | null {
  return chipImplantSiteFromLocation(location);
}
