// HOW a stored place was resolved — the vocabulary of `localidades-por-id`.
//
// A place carries two things (P2: never lose an event's origin place): what was
// ENTERED, and what it RESOLVED to, if anything. The resolved half is one
// `ar_localities` row and the method that reached it. The method is what lets a
// later reader tell an INDEC id the person picked from a name that happened to
// be unique, and both from a place that never resolved at all.
//
// The full list is the design's `place_method` CHECK (stage B adds the column);
// stage A writers only produce the first five. Never add a method that picks
// among homonyms: there is no such method, by construction (P1).

export const PLACE_METHODS = [
  /** The client sent the INDEC id of the row the person picked. */
  "indec_id",
  /** Server-internal: the `ar_localities` uuid itself (CABA barrios have no INDEC id). */
  "catalogue_id",
  /** The name, exactly as the catalogue spells it, names ONE row in its province. */
  "exact_name_unique",
  /** An accent/case/punctuation variant of the name names ONE row in its province. */
  "folded_name_unique",
  /** A pin's reverse-geocoded name named ONE row, and the pin corroborates it. */
  "geocode_unique",
  /** Re-derived from the event spine (a registration or a move that carried the id). */
  "spine_rederived",
  /** Historical backfill of a (province, name) pair that is unique in the catalogue. */
  "legacy_unique_name",
  /** A platform admin resolved it from the unresolved-place queue. */
  "admin_queue",
  /** Nothing named exactly one row: the place is province-level, or unknown. */
  "unresolved",
] as const;

export type PlaceMethod = (typeof PLACE_METHODS)[number];

/** The methods a NAME can resolve by — the only two a text match may claim. */
export type NamePlaceMethod = Extract<PlaceMethod, "exact_name_unique" | "folded_name_unique">;
