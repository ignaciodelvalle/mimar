// Tests for the travel strictness-direction table (movilidad-jurisdiccional
// Fase 1, spec R2.3-R2.4). The table is a CLOSED contract: exactly the 11
// rule types from the spec, each with an explicit combination direction.
// Adding or removing a rule type here requires a spec update first.

import { describe, expect, it } from "vitest";

import {
  STRICTNESS_DIRECTION,
  TRAVEL_RULE_TYPES,
  type TravelRuleType,
} from "@/lib/domain/travel-strictness";

// The full R2.4 table, transcribed from the spec verbatim.
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
};

describe("STRICTNESS_DIRECTION — spec R2.4 closed contract", () => {
  it("contains exactly the 11 rule types from the spec table (no more, no fewer)", () => {
    expect([...TRAVEL_RULE_TYPES].sort()).toEqual(Object.keys(EXPECTED_TABLE).sort());
    expect(TRAVEL_RULE_TYPES).toHaveLength(11);
  });

  it("maps every rule type to the direction mandated by the spec", () => {
    for (const ruleType of TRAVEL_RULE_TYPES) {
      expect(STRICTNESS_DIRECTION[ruleType], ruleType).toBe(EXPECTED_TABLE[ruleType]);
    }
  });

  it("window rules (tightest-deadline-binds) are min", () => {
    expect(STRICTNESS_DIRECTION.document_issuance_window_days).toBe("min");
    expect(STRICTNESS_DIRECTION.parasite_treatment_window_days).toBe("min");
  });

  it("wait/quarantine/min-age rules (longest-requirement-binds) are max", () => {
    expect(STRICTNESS_DIRECTION.rabies_vaccination_to_travel_wait_days).toBe("max");
    expect(STRICTNESS_DIRECTION.rabies_titer_test_wait_days).toBe("max");
    expect(STRICTNESS_DIRECTION.quarantine_days_required).toBe("max");
    expect(STRICTNESS_DIRECTION.rabies_vaccination_min_age_days).toBe("max");
  });

  it("required-flag and set rules (any-jurisdiction-demands-it) are union", () => {
    expect(STRICTNESS_DIRECTION.rabies_titer_test_required).toBe("union");
    expect(STRICTNESS_DIRECTION.import_permit_required).toBe("union");
    expect(STRICTNESS_DIRECTION.microchip_before_vaccination_required).toBe("union");
    expect(STRICTNESS_DIRECTION.required_documents).toBe("union");
    expect(STRICTNESS_DIRECTION.required_vaccines).toBe("union");
  });
});
