import { describe, expect, it } from "vitest";

import {
  PERMANENT_CONDITIONS,
  PERMANENT_CONDITION_GROUPS,
  isPermanentCondition,
  permanentConditionGroup,
  permanentConditionLabel,
  permanentConditionShortLabel,
  resolveLostSpecialConditions,
  sanitizeConditionCodes,
} from "@/lib/reference/permanent-conditions";

describe("permanent-conditions catalog", () => {
  it("isPermanentCondition recognizes catalog codes", () => {
    for (const code of PERMANENT_CONDITIONS) {
      expect(isPermanentCondition(code)).toBe(true);
    }
  });

  it("isPermanentCondition rejects unknown codes", () => {
    expect(isPermanentCondition("invented_condition")).toBe(false);
    expect(isPermanentCondition("")).toBe(false);
  });

  it("every code has a label, a short label, and a known group", () => {
    const validGroups = new Set(PERMANENT_CONDITION_GROUPS.map((g) => g.id));
    for (const code of PERMANENT_CONDITIONS) {
      expect(permanentConditionLabel(code)).toBeTruthy();
      expect(permanentConditionShortLabel(code)).toBeTruthy();
      expect(validGroups.has(permanentConditionGroup(code))).toBe(true);
    }
  });

  it("sanitizeConditionCodes drops unknown codes and keeps order", () => {
    const result = sanitizeConditionCodes(["ciego", "lol_made_up", "sordo", "otra"]);
    expect(result).toEqual(["ciego", "sordo", "otra"]);
  });

  it("sanitizeConditionCodes is idempotent on valid input", () => {
    const valid = ["fiv_positivo", "diabetes"];
    expect(sanitizeConditionCodes(valid)).toEqual(valid);
  });

  it("'otra' is in the catalog so callers can rely on the escape hatch", () => {
    expect(PERMANENT_CONDITIONS).toContain("otra");
  });
});

// resolveLostSpecialConditions — gates the LOST Tier-1 credential's
// welfare-safety disclosure. QA regression: a blind pet's condition was
// silently dropped on the lost credential even though the owner disclosed it.
describe("resolveLostSpecialConditions (lost credential welfare-safety disclosure)", () => {
  it("returns full labels when disclosed — matches Tier2MedicalView's label choice", () => {
    const result = resolveLostSpecialConditions(["ciego", "sordo"], null, true);
    expect(result).toEqual({ labels: ["Ciego/a", "Sordo/a"], other: null });
  });

  it("returns null when discloseConditionsPublicly is false, even with real conditions on the pet", () => {
    const result = resolveLostSpecialConditions(["ciego"], null, false);
    expect(result).toBeNull();
  });

  it("returns null when the pet has no conditions, even when disclosure is on", () => {
    const result = resolveLostSpecialConditions([], null, true);
    expect(result).toBeNull();
  });

  it("surfaces the free-text 'otra' condition alongside catalog labels", () => {
    const result = resolveLostSpecialConditions(["ciego", "otra"], "Necesita jeringa 2x/día", true);
    expect(result).toEqual({ labels: ["Ciego/a"], other: "Necesita jeringa 2x/día" });
  });

  it("drops 'otra' silently when its free-text is missing (defensive — CHECK constraint should prevent this)", () => {
    const result = resolveLostSpecialConditions(["otra"], null, true);
    expect(result).toBeNull();
  });

  it("filters out unknown/stale codes before mapping to labels", () => {
    const result = resolveLostSpecialConditions(["ciego", "invented_condition"], null, true);
    expect(result).toEqual({ labels: ["Ciego/a"], other: null });
  });
});
