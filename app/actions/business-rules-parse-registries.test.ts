// Unit tests for parseRegistriesJson — pure, DB-free.
//
// Covers:
//   1. Round-trip: objects in → JSON serialize → parse → objects out (reorder-safe)
//   2. Empty / null / garbage tolerance
//   3. Malformed items are dropped; valid items are preserved
//   4. The `required` flag is cast correctly (truthy/falsy values)

import { describe, expect, it } from "vitest";

import { parseRegistriesJson } from "@/lib/infra/parse-registries";

// ---------------------------------------------------------------------------
// 1. Round-trip
// ---------------------------------------------------------------------------

describe("parseRegistriesJson — round-trip", () => {
  it("parses a list of registry objects correctly", () => {
    const input = [
      { id: "caba_4078", label: "Registro CABA", required: true },
      { id: "prov_14107", label: "Registro Provincial", required: false },
    ];
    const result = parseRegistriesJson(JSON.stringify(input));
    expect(result).toEqual(input);
  });

  it("preserves order regardless of insertion order (reorder-safe: parse is order-preserving)", () => {
    const a = { id: "a", label: "Alpha", required: true };
    const b = { id: "b", label: "Beta", required: false };
    const c = { id: "c", label: "Gamma", required: true };
    // Reordered relative to original: c, a, b
    const reordered = [c, a, b];
    const result = parseRegistriesJson(JSON.stringify(reordered));
    expect(result).toEqual([c, a, b]);
  });

  it("normalises id and label (trims whitespace)", () => {
    const raw = JSON.stringify([{ id: "  foo  ", label: "  Bar  ", required: true }]);
    const result = parseRegistriesJson(raw);
    expect(result).toEqual([{ id: "foo", label: "Bar", required: true }]);
  });
});

// ---------------------------------------------------------------------------
// 2. Empty / null / garbage tolerance
// ---------------------------------------------------------------------------

describe("parseRegistriesJson — empty / null / garbage", () => {
  it("returns [] for null", () => {
    expect(parseRegistriesJson(null)).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(parseRegistriesJson(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseRegistriesJson("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parseRegistriesJson("   ")).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseRegistriesJson("{not json")).toEqual([]);
  });

  it("returns [] for JSON non-array (object)", () => {
    expect(parseRegistriesJson(JSON.stringify({ id: "x" }))).toEqual([]);
  });

  it("returns [] for JSON primitive", () => {
    expect(parseRegistriesJson(JSON.stringify(42))).toEqual([]);
  });

  it("returns [] for JSON null literal", () => {
    expect(parseRegistriesJson("null")).toEqual([]);
  });

  it("returns [] for empty array", () => {
    expect(parseRegistriesJson("[]")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed items are dropped; valid items are preserved
// ---------------------------------------------------------------------------

describe("parseRegistriesJson — malformed item handling", () => {
  it("drops items with missing id", () => {
    const raw = JSON.stringify([
      { label: "No ID", required: true },
      { id: "valid", label: "Valid", required: false },
    ]);
    const result = parseRegistriesJson(raw);
    expect(result).toEqual([{ id: "valid", label: "Valid", required: false }]);
  });

  it("drops items with missing label", () => {
    const raw = JSON.stringify([
      { id: "no-label", required: true },
      { id: "ok", label: "OK", required: true },
    ]);
    const result = parseRegistriesJson(raw);
    expect(result).toEqual([{ id: "ok", label: "OK", required: true }]);
  });

  it("drops items that are not objects (primitives in array)", () => {
    const raw = JSON.stringify([42, "string", null, { id: "x", label: "X", required: false }]);
    const result = parseRegistriesJson(raw);
    expect(result).toEqual([{ id: "x", label: "X", required: false }]);
  });

  it("drops items where id trims to empty string", () => {
    const raw = JSON.stringify([{ id: "   ", label: "Spaced", required: true }]);
    expect(parseRegistriesJson(raw)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. required flag casting
// ---------------------------------------------------------------------------

describe("parseRegistriesJson — required flag casting", () => {
  it("casts truthy values to true", () => {
    const raw = JSON.stringify([{ id: "x", label: "X", required: 1 }]);
    expect(parseRegistriesJson(raw)[0]?.required).toBe(true);
  });

  it("casts falsy values to false", () => {
    const raw = JSON.stringify([{ id: "x", label: "X", required: 0 }]);
    expect(parseRegistriesJson(raw)[0]?.required).toBe(false);
  });

  it("casts missing required to false", () => {
    const raw = JSON.stringify([{ id: "x", label: "X" }]);
    expect(parseRegistriesJson(raw)[0]?.required).toBe(false);
  });
});
