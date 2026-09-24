// Pure tests for lib/foster-matching.ts — no DB. Covers each warning kind
// in isolation + a perfect-match baseline + an all-mismatches stress case.

import { describe, expect, it } from "vitest";

import { ageMonthsFromDob, computeMatch } from "@/src/modules/foster/domain/matching-rules";

const PERMISSIVE_VOLUNTEER = {
  acceptsDogs: true,
  acceptsCats: true,
  acceptsOtherSpecies: true,
  acceptsSizeSmall: true,
  acceptsSizeMedium: true,
  acceptsSizeLarge: true,
  acceptsPuppies: true,
  acceptsSeniors: true,
  acceptsChronicConditions: true,
  acceptsDangerousBreeds: true,
  maxDurationWeeks: 52,
};

const STRICT_VOLUNTEER = {
  acceptsDogs: false,
  acceptsCats: false,
  acceptsOtherSpecies: false,
  acceptsSizeSmall: false,
  acceptsSizeMedium: false,
  acceptsSizeLarge: false,
  acceptsPuppies: false,
  acceptsSeniors: false,
  acceptsChronicConditions: false,
  acceptsDangerousBreeds: false,
  maxDurationWeeks: 4,
};

describe("foster-matching computeMatch", () => {
  it("perfect match returns 100 and zero warnings", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 15, ageMonths: 24, isPpp: false, hasChronic: false },
      PERMISSIVE_VOLUNTEER,
      4,
    );
    expect(result.score).toBe(100);
    expect(result.warnings).toHaveLength(0);
  });

  it("species mismatch (dog → cat-only volunteer) drops 30", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 5, ageMonths: 24, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsDogs: false },
    );
    expect(result.warnings.some((w) => w.kind === "species_mismatch")).toBe(true);
    expect(result.score).toBe(70);
  });

  it("large-dog size mismatch (35kg dog, small-only volunteer)", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 35, ageMonths: 24, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsSizeLarge: false },
    );
    expect(result.warnings.some((w) => w.kind === "size_mismatch")).toBe(true);
    expect(result.score).toBe(85);
  });

  it("puppy age mismatch (<4mo against volunteer without puppies)", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 3, ageMonths: 2, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsPuppies: false },
    );
    expect(result.warnings.some((w) => w.kind === "age_mismatch")).toBe(true);
    expect(result.score).toBe(85);
  });

  it("senior age mismatch (>84mo against volunteer without seniors)", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 8, ageMonths: 120, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsSeniors: false },
    );
    expect(result.warnings.some((w) => w.kind === "age_mismatch")).toBe(true);
    expect(result.score).toBe(90);
  });

  it("chronic condition mismatch", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 8, ageMonths: 24, isPpp: false, hasChronic: true },
      { ...PERMISSIVE_VOLUNTEER, acceptsChronicConditions: false },
    );
    expect(result.warnings.some((w) => w.kind === "health_mismatch")).toBe(true);
    expect(result.score).toBe(85);
  });

  it("PPP mismatch", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 30, ageMonths: 24, isPpp: true },
      PERMISSIVE_VOLUNTEER,
    );
    // 30kg → large size (PERMISSIVE accepts large), PPP not accepted → -20
    expect(result.warnings.some((w) => w.kind === "ppp_mismatch")).toBe(false);
    expect(result.score).toBe(100); // PERMISSIVE accepts dangerous breeds
    // Test against a volunteer that rejects PPP
    const r2 = computeMatch(
      { species: "dog", estimatedWeightKg: 30, ageMonths: 24, isPpp: true },
      { ...PERMISSIVE_VOLUNTEER, acceptsDangerousBreeds: false },
    );
    expect(r2.warnings.some((w) => w.kind === "ppp_mismatch")).toBe(true);
    expect(r2.score).toBe(80);
  });

  it("duration mismatch (8w proposed against 4w cap)", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 8, ageMonths: 24, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, maxDurationWeeks: 4 },
      8,
    );
    expect(result.warnings.some((w) => w.kind === "duration_mismatch")).toBe(true);
    expect(result.score).toBe(90);
  });

  it("all-mismatch case clamps to 0", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 35, ageMonths: 2, isPpp: true, hasChronic: true },
      STRICT_VOLUNTEER,
      8,
    );
    // species(-30) + size_large(-15) + puppy(-15) + chronic(-15) + ppp(-20) + duration(-10) = -105
    expect(result.score).toBe(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(5);
  });

  it("cat species check goes through acceptsCats flag", () => {
    const cat = computeMatch(
      { species: "cat", estimatedWeightKg: 4, ageMonths: 24, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsCats: false },
    );
    expect(cat.warnings.some((w) => w.kind === "species_mismatch")).toBe(true);
  });

  it("non-dog species skips size check", () => {
    const result = computeMatch(
      { species: "cat", estimatedWeightKg: 30, ageMonths: 24, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsSizeLarge: false },
    );
    // 30kg cat should NOT trigger size warning (size only applies to dogs)
    expect(result.warnings.some((w) => w.kind === "size_mismatch")).toBe(false);
  });

  it("missing ageMonths skips age check silently", () => {
    const result = computeMatch(
      { species: "dog", estimatedWeightKg: 8, ageMonths: null, isPpp: false },
      { ...PERMISSIVE_VOLUNTEER, acceptsPuppies: false, acceptsSeniors: false },
    );
    expect(result.warnings.some((w) => w.kind === "age_mismatch")).toBe(false);
  });
});

describe("ageMonthsFromDob", () => {
  it("returns null when dob is null/undefined", () => {
    expect(ageMonthsFromDob(null)).toBeNull();
    expect(ageMonthsFromDob(undefined)).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(ageMonthsFromDob("not-a-date")).toBeNull();
  });

  it("computes age in months for a 2-year-old", () => {
    const now = new Date("2026-05-18T00:00:00Z");
    const dob = new Date("2024-05-18T00:00:00Z");
    expect(ageMonthsFromDob(dob, now)).toBeGreaterThanOrEqual(23);
    expect(ageMonthsFromDob(dob, now)).toBeLessThanOrEqual(25);
  });

  it("returns null for future dates", () => {
    const now = new Date("2026-05-18T00:00:00Z");
    const future = new Date("2027-05-18T00:00:00Z");
    expect(ageMonthsFromDob(future, now)).toBeNull();
  });
});
