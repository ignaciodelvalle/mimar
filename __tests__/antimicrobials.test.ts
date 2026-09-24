// Unit tests for the antimicrobial classifier (metric A12, Item 3).
//
// Pure truth-table tests over the curated DRUG_CATALOG — no DB connection.
// The classifier decides whether a `medication_started.drug_code` counts as an
// antimicrobial for the AMR / antimicrobial-use-density metric.

import { describe, expect, it } from "vitest";

import {
  ANTIMICROBIAL_CATEGORIES,
  DRUG_CATALOG,
  isAntimicrobial,
  isClassifiedDrug,
} from "@/lib/reference/drugs";

describe("isAntimicrobial", () => {
  it("classifies known antibiotics as antimicrobial", () => {
    // Every catalog drug in an antimicrobial category must classify true.
    const antimicrobials = DRUG_CATALOG.filter((d) =>
      ANTIMICROBIAL_CATEGORIES.includes(d.category),
    );
    expect(antimicrobials.length).toBeGreaterThan(0);
    for (const drug of antimicrobials) {
      expect(isAntimicrobial(drug.code)).toBe(true);
    }
  });

  it("classifies specific known antibiotics true", () => {
    expect(isAntimicrobial("amoxicillin")).toBe(true);
    expect(isAntimicrobial("amoxicillin_clavulanate")).toBe(true);
    expect(isAntimicrobial("cephalexin")).toBe(true);
    expect(isAntimicrobial("enrofloxacin")).toBe(true);
    expect(isAntimicrobial("metronidazole")).toBe(true);
    expect(isAntimicrobial("doxycycline")).toBe(true);
  });

  it("classifies known non-antimicrobial drugs as false", () => {
    // NSAIDs, analgesics, corticoids, cardiac, etc. are NOT antimicrobials.
    expect(isAntimicrobial("meloxicam")).toBe(false);
    expect(isAntimicrobial("tramadol")).toBe(false);
    expect(isAntimicrobial("prednisone")).toBe(false);
    expect(isAntimicrobial("enalapril")).toBe(false);
    expect(isAntimicrobial("fluoxetine")).toBe(false);
    expect(isAntimicrobial("omeprazole")).toBe(false);
  });

  it("returns false for unknown / null / empty codes", () => {
    expect(isAntimicrobial(null)).toBe(false);
    expect(isAntimicrobial(undefined)).toBe(false);
    expect(isAntimicrobial("")).toBe(false);
    expect(isAntimicrobial("not_a_real_drug_code")).toBe(false);
  });

  it("only the antibiotic category is currently antimicrobial", () => {
    // Guard: if a future edit adds a category to ANTIMICROBIAL_CATEGORIES,
    // this test documents that the catalog grew intentionally.
    expect([...ANTIMICROBIAL_CATEGORIES]).toEqual(["antibiotic"]);
  });
});

describe("isClassifiedDrug", () => {
  it("returns true for any code present in the catalog", () => {
    expect(isClassifiedDrug("amoxicillin")).toBe(true);
    expect(isClassifiedDrug("meloxicam")).toBe(true);
  });

  it("returns false for unknown codes (so A12 can mark them provisional)", () => {
    expect(isClassifiedDrug(null)).toBe(false);
    expect(isClassifiedDrug("mystery_compound")).toBe(false);
  });
});
