// Unit tests for application-rules.ts — pure, no DB.
// Written FIRST (RED phase) before creating application-rules.ts.

import { describe, expect, it } from "vitest";

// Will be created in GREEN phase (task 2.4).
import { validateApplicationInput } from "../application-rules";

const baseInput = {
  housingType: "casa_con_patio" as const,
  otherPets: null,
  dailyRoutine: null,
  notes: null,
  profileSharingConsent: true,
  motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
  priorPets: "yes_before" as const,
};

describe("validateApplicationInput", () => {
  // --- institutional account blocked ---
  it("returns error when accountType is institutional", () => {
    const result = validateApplicationInput(
      { ...baseInput },
      { accountType: "institutional" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- profileSharingConsent required ---
  it("returns error when profileSharingConsent is false", () => {
    const result = validateApplicationInput(
      { ...baseInput, profileSharingConsent: false },
      { accountType: "personal" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- duplicate pending detection ---
  it("returns error when existingApplication is provided (duplicate pending)", () => {
    const result = validateApplicationInput(
      { ...baseInput },
      { accountType: "personal" },
      { id: "app-123" },
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- text length caps ---
  it("returns error when otherPets exceeds 2000 characters", () => {
    const result = validateApplicationInput(
      { ...baseInput, otherPets: "a".repeat(2001) },
      { accountType: "personal" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when dailyRoutine exceeds 2000 characters", () => {
    const result = validateApplicationInput(
      { ...baseInput, dailyRoutine: "a".repeat(2001) },
      { accountType: "personal" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when notes exceeds 2000 characters", () => {
    const result = validateApplicationInput(
      { ...baseInput, notes: "a".repeat(2001) },
      { accountType: "personal" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  // --- valid cases ---
  it("returns ok for valid personal account with consent and no duplicate", () => {
    const result = validateApplicationInput({ ...baseInput }, { accountType: "personal" }, null);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for personal account with text at exactly the max length", () => {
    const result = validateApplicationInput(
      { ...baseInput, notes: "a".repeat(2000) },
      { accountType: "personal" },
      null,
    );
    expect(result).toEqual({ ok: true });
  });

  // Triangulation — other housing types are valid
  it("accepts all valid housing types", () => {
    const types = ["casa_con_patio", "casa_sin_patio", "departamento", "otro"] as const;
    for (const housingType of types) {
      expect(
        validateApplicationInput({ ...baseInput, housingType }, { accountType: "personal" }, null),
      ).toEqual({ ok: true });
    }
  });
});
