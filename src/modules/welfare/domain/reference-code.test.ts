// Unit tests for reference code generation, normalization, and format validation.
// Uses Web Crypto via globalThis — available in Node 20+ without polyfills.

import { describe, expect, it } from "vitest";

import {
  generateReferenceCode,
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "./reference-code";

// ---------------------------------------------------------------------------
// generateReferenceCode
// ---------------------------------------------------------------------------

describe("generateReferenceCode", () => {
  it("returns a string matching DEN-XXXX-XXXX format", () => {
    const code = generateReferenceCode();
    expect(isValidReferenceCodeFormat(code)).toBe(true);
  });

  it("always starts with DEN-", () => {
    for (let i = 0; i < 10; i++) {
      expect(generateReferenceCode()).toMatch(/^DEN-/);
    }
  });

  it("generates different codes on successive calls (probabilistic)", () => {
    const codes = new Set(Array.from({ length: 20 }, generateReferenceCode));
    // With entropy ~8.5e11 combinations, all 20 should be unique
    expect(codes.size).toBe(20);
  });

  it("uses only characters from the unambiguous alphabet (no 0, O, 1, I, l)", () => {
    // Generate a large batch and verify no ambiguous chars slip through
    for (let i = 0; i < 50; i++) {
      const code = generateReferenceCode();
      expect(code).not.toMatch(/[0O1Il]/);
    }
  });

  it("has the shape DEN-{4 chars}-{4 chars}", () => {
    const code = generateReferenceCode();
    const parts = code.split("-");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("DEN");
    expect(parts[1]).toHaveLength(4);
    expect(parts[2]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// normalizeReferenceCode
// ---------------------------------------------------------------------------

describe("normalizeReferenceCode", () => {
  it("uppercases a lowercase code", () => {
    expect(normalizeReferenceCode("den-abcd-efgh")).toBe("DEN-ABCD-EFGH");
  });

  it("strips leading and trailing whitespace", () => {
    expect(normalizeReferenceCode("  DEN-ABCD-EFGH  ")).toBe("DEN-ABCD-EFGH");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeReferenceCode("DEN - ABCD - EFGH")).toBe("DEN-ABCD-EFGH");
  });

  it("returns already-normalized codes unchanged", () => {
    expect(normalizeReferenceCode("DEN-2345-6789")).toBe("DEN-2345-6789");
  });
});

// ---------------------------------------------------------------------------
// isValidReferenceCodeFormat
// ---------------------------------------------------------------------------

describe("isValidReferenceCodeFormat", () => {
  it("accepts a valid code", () => {
    expect(isValidReferenceCodeFormat("DEN-ABCD-EFGH")).toBe(true);
  });

  it("accepts codes with digits from the allowed set (2-9)", () => {
    expect(isValidReferenceCodeFormat("DEN-2345-6789")).toBe(true);
  });

  it("rejects codes that contain disallowed chars (0, O, 1, I, l)", () => {
    expect(isValidReferenceCodeFormat("DEN-0BCD-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCO-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-1BCD-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCI-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCl-EFGH")).toBe(false);
  });

  it("rejects codes with wrong prefix", () => {
    expect(isValidReferenceCodeFormat("REP-ABCD-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN_ABCD_EFGH")).toBe(false);
  });

  it("rejects codes with wrong segment lengths", () => {
    expect(isValidReferenceCodeFormat("DEN-ABC-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCDE-EFGH")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCD-EFG")).toBe(false);
    expect(isValidReferenceCodeFormat("DEN-ABCD-EFGHI")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidReferenceCodeFormat("")).toBe(false);
  });

  it("rejects lowercase (format is case-sensitive)", () => {
    expect(isValidReferenceCodeFormat("den-abcd-efgh")).toBe(false);
  });
});
