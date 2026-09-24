// Unit tests for finalize-rules.ts — pure, no DB.
// Written FIRST (RED phase) before creating finalize-rules.ts.

import { describe, expect, it } from "vitest";

// Will be created in GREEN phase (task 2.8).
import { validateFinalizationInput } from "../finalize-rules";

// Helpers
const baseDniInput = {
  applicationEventId: null,
  adopterUserId: null,
  adopterDni: "12345678",
  adopterDisplayName: "Juan Pérez",
  adopterPhone: null,
  followupMonths: null,
  notes: null,
};

const baseFosterInput = {
  applicationEventId: null,
  adopterUserId: "user-foster-1",
  adopterDni: null,
  adopterDisplayName: "",
  adopterPhone: null,
  followupMonths: null,
  notes: null,
};

function makeFosterRow(overrides: Partial<{ id: string; ownerUserId: string | null }> = {}) {
  return {
    id: "foster-row-1",
    ownerUserId: "user-foster-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Approved-application path
// ---------------------------------------------------------------------------

describe("validateFinalizationInput — approved-application path", () => {
  it("short-circuits to ok when applicationEventId is set (identity comes from the event log)", () => {
    const result = validateFinalizationInput(
      {
        ...baseDniInput,
        applicationEventId: "app-evt-1",
        adopterDni: null,
        adopterDisplayName: "",
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  it("ignores a missing DNI when finalizing from an approved application", () => {
    const result = validateFinalizationInput(
      { ...baseDniInput, applicationEventId: "app-evt-1", adopterDni: "" },
      null,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DNI path validations
// ---------------------------------------------------------------------------

describe("validateFinalizationInput — DNI path", () => {
  it("returns error when adopterUserId is absent and DNI is empty", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "" }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when adopterUserId is absent and DNI is null", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: null }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when DNI is too short (fewer than 7 digits after stripping non-digits)", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "123456" }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when DNI is too long (more than 9 digits)", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "1234567890" }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when DNI contains only letters after stripping", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "ABC" }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns ok for DNI with 7 digits (lower bound)", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "1234567" }, null);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for DNI with 9 digits (upper bound)", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "123456789" }, null);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for DNI with formatting characters (dots/spaces stripped)", () => {
    // "12.345.678" → strips to "12345678" → 8 digits → valid
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "12.345.678" }, null);
    expect(result).toEqual({ ok: true });
  });

  // Triangulation — 8-digit DNI
  it("returns ok for 8-digit DNI (common Argentine format)", () => {
    const result = validateFinalizationInput({ ...baseDniInput, adopterDni: "12345678" }, null);
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Foster-shortcut path validations
// ---------------------------------------------------------------------------

describe("validateFinalizationInput — foster-shortcut path", () => {
  it("returns error when adopterUserId provided but no active foster row", () => {
    const result = validateFinalizationInput({ ...baseFosterInput }, null);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when adopterUserId does not match foster row ownerUserId", () => {
    const fosterRow = makeFosterRow({ ownerUserId: "different-user" });
    const result = validateFinalizationInput({ ...baseFosterInput }, fosterRow);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns ok when adopterUserId matches active foster row ownerUserId", () => {
    const fosterRow = makeFosterRow({ ownerUserId: "user-foster-1" });
    const result = validateFinalizationInput({ ...baseFosterInput }, fosterRow);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when fosterRow.ownerUserId is null and adopterUserId is provided — this counts as mismatch", () => {
    // A foster row with null ownerUserId should not match
    const fosterRow = makeFosterRow({ ownerUserId: null });
    const result = validateFinalizationInput({ ...baseFosterInput }, fosterRow);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
