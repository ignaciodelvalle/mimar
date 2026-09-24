// Chip implant site mapping.
//
// Extracted from src/modules/pets/domain/pet-rules.ts (2026-07-18 dependency-
// direction cleanup — see scripts/check-dependency-direction.ts). Both the
// `pets` module (writing petIdentifications on registration/update) and the
// `events` module (writing petIdentifications as a side effect of processing
// a microchip event) normalize the same raw form/event value against the
// same DB enum. Neither module "owns" that enum shape more than the other —
// it lives here, outside src/modules/**, so consuming it never creates a
// cross-module edge for either side.
//
// Zero external imports — pure mapping only.

export type ChipImplantSite =
  | "interescapular"
  | "lateral_cuello_izq"
  | "lateral_cuello_der"
  | "otro"
  | null;

/**
 * Maps the microchipLocation field value (from the form, or an event
 * payload's location_on_body) to the petIdentifications implantationSite
 * enum value. Preserves the exact 5-way branch from the original pets.ts
 * implementation.
 */
export function chipImplantSiteFromLocation(location: string | null): ChipImplantSite {
  switch (location) {
    // Canonical enum pass-throughs — already normalized, return as-is.
    case "interescapular":
      return "interescapular";
    case "lateral_cuello_izq":
      return "lateral_cuello_izq";
    case "lateral_cuello_der":
      return "lateral_cuello_der";
    // Legacy form-field aliases → canonical enum.
    case "interscapular_left":
    case "interscapular_right":
    case "interscapular":
      return "interescapular";
    case "neck_left":
      return "lateral_cuello_izq";
    case "neck_right":
      return "lateral_cuello_der";
    default:
      return location ? "otro" : null;
  }
}
