// Tests for the travel strictness-direction table (movilidad-jurisdiccional
// Fase 1, spec R2.3-R2.4; widened by viajes-fase-2 design D2). The table is a
// CLOSED contract: exactly these rule types, each with an explicit combination
// direction. Adding or removing a rule type here requires a spec update first.

import { describe, expect, it } from "vitest";

import {
  STRICTNESS_DIRECTION,
  TRAVEL_RULE_TYPES,
  type TravelRuleType,
} from "@/lib/domain/travel-strictness";

// The R2.4 table (Fase 1, 11 types) plus the design D2 table (viajes-fase-2,
// 8 types in 7 rows — embargoes and booking lead time share one).
const EXPECTED_TABLE: Record<TravelRuleType, "min" | "max" | "union"> = {
  document_issuance_window_days: "min",
  rabies_vaccination_to_travel_wait_days: "max",
  rabies_titer_test_wait_days: "max",
  quarantine_days_required: "max",
  rabies_vaccination_min_age_days: "max",
  parasite_treatment_window_days: "min",
  rabies_titer_test_required: "union",
  import_permit_required: "union",
  microchip_before_vaccination_required: "union",
  required_documents: "union",
  required_vaccines: "union",
  // viajes-fase-2 design D2.
  min_animal_age_days: "max",
  parasite_treatment_min_days_before: "max",
  rabies_vaccination_max_days_before_travel: "min",
  microchip_required: "union",
  max_weight_kg: "min",
  breed_restrictions: "union",
  embargoes: "union",
  booking_lead_hours: "max",
};

describe("STRICTNESS_DIRECTION — spec R2.4 + design D2 closed contract", () => {
  it("contains exactly the 19 rule types (11 from Fase 1, 8 from viajes-fase-2)", () => {
    expect([...TRAVEL_RULE_TYPES].sort()).toEqual(Object.keys(EXPECTED_TABLE).sort());
    expect(TRAVEL_RULE_TYPES).toHaveLength(19);
  });

  it("maps every rule type to the direction mandated by the spec/design", () => {
    for (const ruleType of TRAVEL_RULE_TYPES) {
      expect(STRICTNESS_DIRECTION[ruleType], ruleType).toBe(EXPECTED_TABLE[ruleType]);
    }
  });

  it("window ceilings and limits (tightest binds) are min", () => {
    expect(STRICTNESS_DIRECTION.document_issuance_window_days).toBe("min");
    expect(STRICTNESS_DIRECTION.parasite_treatment_window_days).toBe("min");
    expect(STRICTNESS_DIRECTION.rabies_vaccination_max_days_before_travel).toBe("min");
    expect(STRICTNESS_DIRECTION.max_weight_kg).toBe("min");
  });

  it("waits, floors and minimum ages (longest binds) are max", () => {
    expect(STRICTNESS_DIRECTION.rabies_vaccination_to_travel_wait_days).toBe("max");
    expect(STRICTNESS_DIRECTION.rabies_titer_test_wait_days).toBe("max");
    expect(STRICTNESS_DIRECTION.quarantine_days_required).toBe("max");
    expect(STRICTNESS_DIRECTION.rabies_vaccination_min_age_days).toBe("max");
    expect(STRICTNESS_DIRECTION.min_animal_age_days).toBe("max");
    expect(STRICTNESS_DIRECTION.parasite_treatment_min_days_before).toBe("max");
    expect(STRICTNESS_DIRECTION.booking_lead_hours).toBe("max");
  });

  it("required-flag and set rules (any-source-demands-it) are union", () => {
    expect(STRICTNESS_DIRECTION.rabies_titer_test_required).toBe("union");
    expect(STRICTNESS_DIRECTION.import_permit_required).toBe("union");
    expect(STRICTNESS_DIRECTION.microchip_before_vaccination_required).toBe("union");
    expect(STRICTNESS_DIRECTION.microchip_required).toBe("union");
    expect(STRICTNESS_DIRECTION.required_documents).toBe("union");
    expect(STRICTNESS_DIRECTION.required_vaccines).toBe("union");
    expect(STRICTNESS_DIRECTION.breed_restrictions).toBe("union");
    expect(STRICTNESS_DIRECTION.embargoes).toBe("union");
  });
});
