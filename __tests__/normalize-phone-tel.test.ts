// UI-4 fix 6 — normalizePhoneForTel.
//
// Verifies the conservative AR-centric phone normalizer used for tel: hrefs on
// the public lost credential. It must:
//   - keep already-international "+" numbers (stripping pretty separators)
//   - convert "00" international access to "+"
//   - confidently stamp +54 only for plausible AR national numbers
//   - fall back to digits-only (never guess) for ambiguous input
//   - return null for empty/garbage

import { describe, expect, it } from "vitest";

import { normalizePhoneForTel } from "@/lib/utils/format";

describe("normalizePhoneForTel", () => {
  it("returns null for empty/nullish", () => {
    expect(normalizePhoneForTel(null)).toBeNull();
    expect(normalizePhoneForTel(undefined)).toBeNull();
    expect(normalizePhoneForTel("")).toBeNull();
    expect(normalizePhoneForTel("   ")).toBeNull();
    expect(normalizePhoneForTel("abc")).toBeNull();
  });

  it("keeps an explicit + number and strips pretty separators", () => {
    expect(normalizePhoneForTel("+54 9 221 555-1234")).toBe("+5492215551234");
    expect(normalizePhoneForTel("+1 (555) 123 4567")).toBe("+15551234567");
  });

  it("converts a 00 international access code to +", () => {
    expect(normalizePhoneForTel("0054 221 555 1234")).toBe("+542215551234");
  });

  it("keeps numbers that already carry the 54 country code", () => {
    expect(normalizePhoneForTel("54 221 555 1234")).toBe("+542215551234");
  });

  it("stamps +54 for a national trunk-0 number of plausible length", () => {
    // "0" + 10 national digits (2215551234) → +54 + the 10 national digits.
    expect(normalizePhoneForTel("0 2215551234")).toBe("+542215551234");
    expect(normalizePhoneForTel("(0221) 5551-234")).toBe("+542215551234");
  });

  it("stamps +54 for a bare 10-digit national number", () => {
    expect(normalizePhoneForTel("2215551234")).toBe("+542215551234");
  });

  it("falls back to digits-only for ambiguous trunk-0 numbers", () => {
    // Leading 0 but not 10 national digits — not confident, drop the 0 only.
    expect(normalizePhoneForTel("0221 5551")).toBe("2215551");
  });

  it("falls back to digits-only for short ambiguous numbers", () => {
    expect(normalizePhoneForTel("5551234")).toBe("5551234");
  });
});
