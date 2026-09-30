// Travel strictness-direction table (movilidad-jurisdiccional Fase 1, widened
// by viajes-fase-2 design D2).
//
// Spec R2.3-R2.4: when travel obligations are combined across the trip's
// corridor(s) and the chosen airline, each rule type declares its OWN
// combination direction — never a single global "strictest wins" applied
// uniformly. The direction is a property of the rule type, not a runtime
// decision:
//
//   - "min"   → the TIGHTEST window/limit binds (e.g. a health certificate
//               must be issued close enough to travel to satisfy every source).
//   - "max"   → the LONGEST wait/quarantine/minimum binds.
//   - "union" → required if ANY applicable source requires it; for set
//               values the traveler carries the union, never a subset.
//
// This table is a CLOSED contract: the aggregation in
// lib/projections/travel-compliance.ts computes exactly these rule types.
// Fase 1 shipped 11; viajes-fase-2 (design D2, spec "Evaluate rules against
// libreta events") adds 8 — the design's table lists them in 7 rows because
// embargoes and booking lead time share one. Adding a rule type here without
// a spec update is an incomplete implementation — the coverage test in
// travel-strictness.test.ts pins the exact set.

import type { Sourced } from "@/lib/domain/travel-freshness";

export const TRAVEL_RULE_TYPES = [
  "document_issuance_window_days",
  "rabies_vaccination_to_travel_wait_days",
  "rabies_titer_test_wait_days",
  "quarantine_days_required",
  "rabies_vaccination_min_age_days",
  "parasite_treatment_window_days",
  "rabies_titer_test_required",
  "import_permit_required",
  "microchip_before_vaccination_required",
  "required_documents",
  "required_vaccines",
  // viajes-fase-2 (design D2).
  "min_animal_age_days",
  "parasite_treatment_min_days_before",
  "rabies_vaccination_max_days_before_travel",
  "microchip_required",
  "max_weight_kg",
  "breed_restrictions",
  "embargoes",
  "booking_lead_hours",
] as const;

export type TravelRuleType = (typeof TRAVEL_RULE_TYPES)[number];

export type StrictnessDirection = "min" | "max" | "union";

/**
 * Per-rule-type combination direction (spec R2.4 + design D2 — exhaustive).
 * `satisfies` keeps the map total: adding a TravelRuleType without a
 * direction fails typecheck.
 */
export const STRICTNESS_DIRECTION = {
  // Max days before travel a health certificate/CVI may be issued and still
  // be valid — shorter window = less slack, tightest deadline binds.
  document_issuance_window_days: "min",
  // Min days between rabies vaccination and travel — longest wait binds.
  rabies_vaccination_to_travel_wait_days: "max",
  // Min days after a rabies titer test before travel — longest wait binds.
  rabies_titer_test_wait_days: "max",
  // Min mandatory quarantine days at destination — longest binds.
  quarantine_days_required: "max",
  // Minimum pet age (days) at first rabies vaccination — oldest minimum binds.
  rabies_vaccination_min_age_days: "max",
  // Max days before travel a parasite treatment may be administered (the
  // CEILING) — shorter window = stricter, treatment must be closer to departure.
  parasite_treatment_window_days: "min",
  // Mandatory if ANY applicable source requires it.
  rabies_titer_test_required: "union",
  import_permit_required: "union",
  microchip_before_vaccination_required: "union",
  // Set values: the traveler carries the union, never a subset.
  required_documents: "union",
  required_vaccines: "union",
  // Minimum age of the ANIMAL on the travel date (USA dog 6 months, airline
  // minimums) — the oldest minimum binds.
  min_animal_age_days: "max",
  // The FLOOR of the deworming window (Chile: at least 5 days before the CZI)
  // — the longest floor binds.
  parasite_treatment_min_days_before: "max",
  // The last rabies dose may be at most this old on the travel date (an
  // airline's maxDaysSinceDose) — the tightest ceiling binds.
  rabies_vaccination_max_days_before_travel: "min",
  // A microchip is mandatory if any source says so.
  microchip_required: "union",
  // Maximum weight an airline accepts — the lowest limit binds.
  max_weight_kg: "min",
  // Airline-only sets: every restriction and embargo that applies is carried.
  breed_restrictions: "union",
  embargoes: "union",
  // Booking lead time — the longest notice binds.
  booking_lead_hours: "max",
} as const satisfies Record<TravelRuleType, StrictnessDirection>;

/** Travel species a rule can be scoped to. */
export type TravelSpecies = "dog" | "cat";

/** How a pet travels on a flight. A SELECTOR, never a rule (design D2). */
export type Modality = "cabin" | "hold" | "cargo";

/**
 * The document a window rule is about. The key matters: the USA 5-day window
 * is the miasis certificate, not the CVI — merging the two would tell an
 * owner their CVI must be 5 days old.
 */
export type TravelDocument =
  | "senasa_cvi"
  | "miasis_certificate"
  | "vet_health_certificate"
  | "rabies_certificate"
  | "senasa_boarding_permit"
  | "airline_form";

/** A breed restriction an airline publishes (design D1). */
export type BreedRestriction = {
  kind: "brachycephalic" | "dangerous_list" | "airline_veto";
  /** Catalogue labels, or the curated brachycephalic list. */
  breeds: "BRACHYCEPHALIC_LIST" | readonly string[];
  /** Breeds the airline names that the catalogue does not list, verbatim. */
  offCatalogue?: readonly string[];
  appliesTo: readonly Modality[];
  effect: "banned" | "muzzle" | "cabin_only";
};

/** A period or condition in which an airline does not carry pets. */
export type Embargo = {
  kind: "seasonal" | "temperature" | "route";
  /** MM-DD, for seasonal embargoes. */
  from?: string;
  to?: string;
  note: string;
};

/**
 * Value shape per rule type: windows/waits are day counts, requirement flags
 * are booleans, document/vaccine demands are string sets.
 */
export type TravelRuleValueByType = {
  document_issuance_window_days: number;
  rabies_vaccination_to_travel_wait_days: number;
  rabies_titer_test_wait_days: number;
  quarantine_days_required: number;
  rabies_vaccination_min_age_days: number;
  parasite_treatment_window_days: number;
  rabies_titer_test_required: boolean;
  import_permit_required: boolean;
  microchip_before_vaccination_required: boolean;
  required_documents: readonly string[];
  required_vaccines: readonly string[];
  min_animal_age_days: number;
  parasite_treatment_min_days_before: number;
  rabies_vaccination_max_days_before_travel: number;
  microchip_required: boolean;
  max_weight_kg: number;
  breed_restrictions: readonly BreedRestriction[];
  embargoes: readonly Embargo[];
  booking_lead_hours: number;
};

/**
 * One declared rule with its provenance (design D2). `appliesToSpecies`
 * scopes it (Uruguay's microchip is for dogs); `document` says which paper a
 * document window is about.
 */
export type RuleEnvelope<V> = Sourced<V> & {
  appliesToSpecies?: readonly TravelSpecies[];
  document?: TravelDocument;
};

/** A corridor's rule table: at most one envelope per rule type. */
export type TravelRuleEnvelopes = {
  [K in TravelRuleType]?: RuleEnvelope<TravelRuleValueByType[K]>;
};

/**
 * Severity dimension of a travel obligation (spec R2.5-R2.6). Exists ONLY on
 * the travel aggregation output — the domestic 4-card ObligationCard MUST NOT
 * gain this field in Fase 1 (spec R4.3).
 */
export type RequirementLevel = "blocker" | "warning" | "info";
