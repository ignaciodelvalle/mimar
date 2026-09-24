import {
  CHIP_CONFLICTS_WITH_CANONICAL_ERROR,
  checkChipMatchesCanonical,
  validateMicrochipId,
} from "@/lib/domain/microchip-validation";
import { describe, expect, it } from "vitest";

describe("validateMicrochipId", () => {
  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it("accepts exactly 15 digits and returns normalized form", () => {
    const result = validateMicrochipId("123456789012345");
    expect(result).toEqual({ ok: true, normalized: "123456789012345" });
  });

  it("strips leading/trailing whitespace before validation", () => {
    const result = validateMicrochipId("  123456789012345  ");
    expect(result).toEqual({ ok: true, normalized: "123456789012345" });
  });

  it("strips internal spaces and returns 15 digits", () => {
    const result = validateMicrochipId("12345 67890 12345");
    expect(result).toEqual({ ok: true, normalized: "123456789012345" });
  });

  it("strips hyphens and returns 15 digits", () => {
    const result = validateMicrochipId("12345-67890-12345");
    expect(result).toEqual({ ok: true, normalized: "123456789012345" });
  });

  it("strips mixed spaces and hyphens", () => {
    const result = validateMicrochipId("123 45-678 90-12345");
    expect(result).toEqual({ ok: true, normalized: "123456789012345" });
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  it("rejects a 14-digit string", () => {
    const result = validateMicrochipId("12345678901234");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/14/);
    }
  });

  it("rejects a 16-digit string", () => {
    const result = validateMicrochipId("1234567890123456");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/16/);
    }
  });

  it("rejects a string with letters", () => {
    const result = validateMicrochipId("ABCDE6789012345");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/dígitos/i);
    }
  });

  it("rejects a string with letters mixed among digits", () => {
    const result = validateMicrochipId("1234A6789012345");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/dígitos/i);
    }
  });

  it("rejects an empty string", () => {
    const result = validateMicrochipId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects a whitespace-only string", () => {
    const result = validateMicrochipId("   ");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkChipMatchesCanonical — the guard that keeps the spine from contradicting
// the credential. See lib/domain/microchip-validation.ts for the full why.
// ---------------------------------------------------------------------------

describe("checkChipMatchesCanonical", () => {
  const ON_RECORD = "985121025800001";

  it("allows the first chip: a pet with no canonical row has nothing to contradict", () => {
    expect(checkChipMatchesCanonical(null, ON_RECORD)).toBeNull();
  });

  it("allows re-submitting the identical chip (double-submit / partial-write re-sync)", () => {
    expect(checkChipMatchesCanonical(ON_RECORD, ON_RECORD)).toBeNull();
  });

  it("allows the same digits typed with the separators people actually use", () => {
    expect(checkChipMatchesCanonical(ON_RECORD, "985 121-025 800 001")).toBeNull();
    expect(checkChipMatchesCanonical("985-121-025-800-001", ON_RECORD)).toBeNull();
  });

  it("rejects a different chip and says which flow to use instead", () => {
    const conflict = checkChipMatchesCanonical(ON_RECORD, "985121025809999");
    // Pinned to the exact string: the copy IS the fix's user-facing half. It
    // has to name the scanner (the typo branch) AND route to «Reemplazar
    // microchip» (the genuine-new-chip branch), or the person is left with a
    // dead end and the divergence goes unresolved.
    expect(conflict).toEqual({ error: CHIP_CONFLICTS_WITH_CANONICAL_ERROR });
    expect(CHIP_CONFLICTS_WITH_CANONICAL_ERROR).toContain("escáner");
    expect(CHIP_CONFLICTS_WITH_CANONICAL_ERROR).toContain("Reemplazar microchip");
  });

  it("never echoes either chip number back to the caller", () => {
    const conflict = checkChipMatchesCanonical(ON_RECORD, "985121025809999");
    // Same non-disclosure the atender confirm path already enforces: the signer
    // types what the scanner reads, not what the screen showed them.
    expect(conflict?.error).not.toContain(ON_RECORD);
    expect(conflict?.error).not.toContain("985121025809999");
  });

  it("catches a single mistyped digit — the case a boolean guard could never see", () => {
    expect(checkChipMatchesCanonical(ON_RECORD, "985121025800002")).not.toBeNull();
  });

  it("compares non-ISO legacy codes against themselves rather than rejecting them", () => {
    // Neither side parses as ISO; the fallback still has to call identical
    // strings identical, or a pre-ISO row would be unrepairable.
    expect(checkChipMatchesCanonical("LEGACY-01", " LEGACY-01 ")).toBeNull();
    expect(checkChipMatchesCanonical("LEGACY-01", "LEGACY-02")).not.toBeNull();
  });
});
