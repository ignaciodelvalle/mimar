// Travel strictness-direction table (movilidad-jurisdiccional Fase 1).
//
// Spec R2.3-R2.4: when travel obligations are combined across the pet's
// origin and destination jurisdictions, each rule type declares its OWN
// combination direction — never a single global "strictest wins" applied
// uniformly. The direction is a property of the rule type, not a runtime
// decision:
//
//   - "min"   → the TIGHTEST window binds (e.g. a health certificate must be
//               issued close enough to travel to satisfy every jurisdiction).
//   - "max"   → the LONGEST wait/quarantine/minimum binds.
//   - "union" → required if ANY applicable jurisdiction requires it; for set
//               values the traveler carries the union, never a subset.
//
// This table is a CLOSED contract for Fase 1 (spec R2.4): the aggregation in
// lib/projections/travel-compliance.ts computes exactly these 11 rule types.
// Adding a rule type here without a spec update is an incomplete
// implementation — the coverage test in travel-strictness.test.ts pins the
// exact set.

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
] as const;

export type TravelRuleType = (typeof TRAVEL_RULE_TYPES)[number];

export type StrictnessDirection = "min" | "max" | "union";

/**
 * Per-rule-type combination direction (spec R2.4 — full table, exhaustive).
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
  // Max days before travel a parasite treatment may be administered —
  // shorter window = stricter, treatment must be closer to departure.
  parasite_treatment_window_days: "min",
  // Mandatory if ANY applicable jurisdiction requires it.
  rabies_titer_test_required: "union",
  import_permit_required: "union",
  microchip_before_vaccination_required: "union",
  // Set values: the traveler carries the union, never a subset.
  required_documents: "union",
  required_vaccines: "union",
} as const satisfies Record<TravelRuleType, StrictnessDirection>;

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
};

/**
 * Severity dimension of a travel obligation (spec R2.5-R2.6). Exists ONLY on
 * the travel aggregation output — the domestic 4-card ObligationCard MUST NOT
 * gain this field in Fase 1 (spec R4.3).
 */
export type RequirementLevel = "blocker" | "warning" | "info";
