// Unit tests for eligibility-rules.ts — pure, no DB.
// Written FIRST (RED phase) before creating eligibility-rules.ts.

import { describe, expect, it } from "vitest";

// Will be created in GREEN phase (task 2.2).
import { validateEligibilityInput } from "../eligibility-rules";

describe("validateEligibilityInput", () => {
  // --- ineligible without reason ---
  it("returns error when eligible=false and no ineligibleReason", () => {
    const result = validateEligibilityInput({ eligible: false });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when eligible=false and ineligibleReason is null", () => {
    const result = validateEligibilityInput({ eligible: false, ineligibleReason: null });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- eligible with reason ---
  it("returns error when eligible=true and ineligibleReason is provided", () => {
    const result = validateEligibilityInput({
      eligible: true,
      ineligibleReason: "medical_treatment",
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- invalid reason ---
  it("returns error when ineligibleReason is not in the allowed enum", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "not_a_real_reason" as ReturnType<() => never>,
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- reason=other needs notes ---
  it("returns error when reason=other and notes is blank", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "other",
      ineligibleReasonNotes: "",
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when reason=other and notes is only whitespace", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "other",
      ineligibleReasonNotes: "   ",
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when reason=other and notes is null", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "other",
      ineligibleReasonNotes: null,
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- invalid date ---
  it("returns error when ineligibleUntilIso is not a valid date", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "medical_treatment",
      ineligibleUntilIso: "not-a-date",
    });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- valid cases ---
  it("returns ok when eligible=true with no reason", () => {
    const result = validateEligibilityInput({ eligible: true });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when eligible=false with a valid reason", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "medical_treatment",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when reason=other with non-blank notes", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "other",
      ineligibleReasonNotes: "Needs behavioral evaluation first.",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when a valid ineligibleUntilIso is provided", () => {
    const result = validateEligibilityInput({
      eligible: false,
      ineligibleReason: "recovery",
      ineligibleUntilIso: "2025-12-31T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: true });
  });

  // Triangulation — additional reason values
  it("returns ok for each valid ineligible reason (triangulation)", () => {
    const validReasons = [
      "behavioral_evaluation",
      "recovery",
      "quarantine",
      "legal_hold",
      "age",
      "pending_intake_eval",
    ] as const;
    for (const reason of validReasons) {
      expect(validateEligibilityInput({ eligible: false, ineligibleReason: reason })).toEqual({
        ok: true,
      });
    }
  });
});
