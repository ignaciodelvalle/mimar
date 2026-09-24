// Unit tests for lib/analytics/mandating-jurisdictions.ts (jurisdiction-
// compliance WU4a, spec MN1/MN3 — T4.10).
//
// THE dedicated cascade-correctness suite: a `not_regulated` override sitting
// UNDER a `mandatory` parent must EXCLUDE its jurisdiction from the mandated
// denominator (the family's highest metric-bug risk). Pure — the classifier
// is exercised over in-memory rows; the DB integration (and the parity check
// against the real resolveBusinessRule cascade) lives in
// __tests__/mandated-denominator-cascade.test.ts.

import { describe, expect, it } from "vitest";

import {
  type ObligationRuleRow,
  buildMandatingClassifier,
  pickObligationRule,
  rowMandates,
} from "./mandating-jurisdictions";

const row = (partial: Partial<ObligationRuleRow>): ObligationRuleRow => ({
  province: null,
  locality: null,
  requirementLevel: null,
  payload: {},
  ...partial,
});

describe("pickObligationRule — cascade pick (locality > province > country)", () => {
  const rows = [
    row({ requirementLevel: "mandatory" }), // country
    row({ province: "La Pampa", requirementLevel: "not_regulated" }),
    row({ province: "La Pampa", locality: "Santa Rosa", requirementLevel: "mandatory" }),
  ];

  it("locality row wins over its province row", () => {
    expect(pickObligationRule(rows, "La Pampa", "Santa Rosa")?.requirementLevel).toBe("mandatory");
  });

  it("province row wins over the country row for other localities", () => {
    expect(pickObligationRule(rows, "La Pampa", "General Pico")?.requirementLevel).toBe(
      "not_regulated",
    );
  });

  it("country row governs provinces with no row of their own", () => {
    expect(pickObligationRule(rows, "Chubut", null)?.requirementLevel).toBe("mandatory");
  });

  it("returns null when nothing matches at any tier", () => {
    expect(pickObligationRule([rows[1]], "Chubut", null)).toBeNull();
  });

  it("a null-locality jurisdiction skips locality rows entirely", () => {
    expect(pickObligationRule(rows, "La Pampa", null)?.requirementLevel).toBe("not_regulated");
  });
});

describe("rowMandates — mandate semantics per rule type", () => {
  it("NO matched row never mandates — the RG2 default cannot create a denominator", () => {
    expect(rowMandates("microchip_required", null)).toBe(false);
    expect(rowMandates("rabies_vaccination", null)).toBe(false);
    expect(rowMandates("sterilization", null)).toBe(false);
  });

  it("rabies/sterilization mandate only on an EXPLICIT mandatory tier", () => {
    expect(rowMandates("rabies_vaccination", row({ requirementLevel: "mandatory" }))).toBe(true);
    expect(rowMandates("rabies_vaccination", row({ requirementLevel: "recommended" }))).toBe(false);
    expect(rowMandates("rabies_vaccination", row({ requirementLevel: "not_regulated" }))).toBe(
      false,
    );
    // A matched row with NO tier claims nothing for the metric — deliberately
    // stricter than the owner surface's pre-tier fallback (obligationRuleInfo).
    expect(rowMandates("sterilization", row({ requirementLevel: null }))).toBe(false);
  });

  it("microchip follows the OR5 gate over the matched row (tier supersedes boolean)", () => {
    expect(
      rowMandates("microchip_required", row({ requirementLevel: "mandatory", payload: {} })),
    ).toBe(true);
    expect(
      rowMandates(
        "microchip_required",
        row({ requirementLevel: "not_regulated", payload: { required: true } }),
      ),
    ).toBe(false);
    // Tier-less legacy rows: the boolean governs (behavior parity with the
    // profile gate, microchipObligationApplies).
    expect(
      rowMandates(
        "microchip_required",
        row({ requirementLevel: null, payload: { required: true } }),
      ),
    ).toBe(true);
    expect(
      rowMandates(
        "microchip_required",
        row({ requirementLevel: null, payload: { required: false } }),
      ),
    ).toBe(false);
  });
});

describe("buildMandatingClassifier — the T4.10 cascade-exclusion fence", () => {
  it("a not_regulated LOCALITY override under a mandatory PROVINCE is excluded (highest metric-bug risk)", () => {
    const classifier = buildMandatingClassifier("rabies_vaccination", [
      row({ province: "Chubut", requirementLevel: "mandatory" }),
      row({ province: "Chubut", locality: "Trelew", requirementLevel: "not_regulated" }),
    ]);
    expect(classifier.isMandated("Chubut", "Trelew")).toBe(false); // the override
    expect(classifier.isMandated("Chubut", "Rawson")).toBe(true); // siblings keep the mandate
    expect(classifier.isMandated("Chubut", null)).toBe(true); // province grain
  });

  it("a not_regulated PROVINCE override under a mandatory COUNTRY row is excluded", () => {
    const classifier = buildMandatingClassifier("sterilization", [
      row({ requirementLevel: "mandatory" }),
      row({ province: "Salta", requirementLevel: "not_regulated" }),
    ]);
    expect(classifier.isMandated("Salta", "Cafayate")).toBe(false);
    expect(classifier.isMandated("Jujuy", null)).toBe(true);
  });

  it("the inverse cascade works too — a mandatory locality inside a not_regulated province", () => {
    const classifier = buildMandatingClassifier("microchip_required", [
      row({ province: "Salta", requirementLevel: "not_regulated", payload: { required: false } }),
      row({
        province: "Salta",
        locality: "Cafayate",
        requirementLevel: "mandatory",
        payload: { required: true },
      }),
    ]);
    expect(classifier.isMandated("Salta", "Cafayate")).toBe(true);
    expect(classifier.isMandated("Salta", "Tartagal")).toBe(false);
  });

  it("no rows loaded → nothing is mandated anywhere (NULL-tier dev state is honest-empty)", () => {
    const classifier = buildMandatingClassifier("microchip_required", []);
    expect(classifier.ruleCount).toBe(0);
    expect(classifier.isMandated("Chubut", "Trelew")).toBe(false);
    expect(classifier.isMandated(null, null)).toBe(false);
  });
});
