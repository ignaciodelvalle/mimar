// HOW a stored place was resolved — the vocabulary of `localidades-por-id`.
//
// A place carries two things (P2: never lose an event's origin place): what was
// ENTERED, and what it RESOLVED to, if anything. The resolved half is one
// `ar_localities` row and the method that reached it. The method is what lets a
// later reader tell an INDEC id the person picked from a name that happened to
// be unique, and both from a place that never resolved at all.
//
// The full list is the `place_method` CHECK of migration 0248, in the same
// order (__tests__/place-columns.test.ts compares them). Never add a method that picks
// among homonyms: there is no such method, by construction (P1). The one method
// that settles a homonym does it on evidence the record itself carries, never
// by picking, and lives only in the event_places projection
// (EVENT_PLACE_METHODS, below).

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
  /**
   * The pin named no row with certainty, so the person was shown the catalogue
   * rows near it ("¿Es acá?", homonyms labelled with their department) and
   * picked one. Explicit, by id — never inferred from the point alone.
   */
  "user_picked",
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

/**
 * Methods only a REPAIR of the event_places projection may record — never a
 * writer of a place column, never an event payload. Kept out of PLACE_METHODS
 * on purpose: that list is also the payload schema (lib/events/place-payload.ts)
 * and the `place_method` CHECK of every 0248 table, none of which accepts these.
 */
export const EVENT_PLACE_REPAIR_METHODS = [
  /**
   * The name named two or more rows of the province (a homonym), and the
   * event's OWN recorded point sat clearly next to one of their centroids
   * (lib/place/event-places-coordinate-pass.ts: nearest ≤ 20 km, runner-up
   * ≥ 10 km farther and twice as far). Migration 0291.
   */
  "homonym_by_coordinates",
] as const;

export type EventPlaceRepairMethod = (typeof EVENT_PLACE_REPAIR_METHODS)[number];

/**
 * The full `event_places.method` (and `place_resolutions.method`) CHECK, in
 * order: 0250's list, then 0291's (__tests__/event-places-method-check.test.ts
 * compares them).
 */
export const EVENT_PLACE_METHODS = [...PLACE_METHODS, ...EVENT_PLACE_REPAIR_METHODS] as const;
