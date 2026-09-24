// Unit tests for the CAS-XXXX-XXXX public_code generator.
//
// generateUniqueCasePublicCode hits the DB to check uniqueness, but
// generatePrefixedToken is pure and is what we cover here:
//  - Format is CAS-XXXX-XXXX (uppercase alphanumeric, 4+4).
//  - Collision rate over 10k samples is zero (alphabet 32, 8 chars,
//    ~1.1e12 space — collisions should be ~zero at this scale).

import { describe, expect, it } from "vitest";

import { generatePrefixedToken } from "@/lib/infra/publicToken";

// Alphabet is "ABCDEFGHJKMNPQRSTUVWXYZ23456789" — excludes I, L, O, 0, 1.
const CAS_FORMAT =
  /^CAS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

describe("CAS-XXXX-XXXX public_code generator", () => {
  it("generates a code matching CAS-XXXX-XXXX format", () => {
    const code = generatePrefixedToken("CAS");
    expect(code).toMatch(CAS_FORMAT);
  });

  it("never collides over 10k samples", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      samples.add(generatePrefixedToken("CAS"));
    }
    expect(samples.size).toBe(10_000);
  });

  it("each segment uses only the visually-unambiguous alphabet (no I/L/O/0/1)", () => {
    const allowed = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;
    for (let i = 0; i < 200; i++) {
      const code = generatePrefixedToken("CAS");
      const body = code.slice("CAS-".length);
      expect(body).toMatch(allowed);
      expect(body).not.toMatch(/[IL01O]/);
    }
  });
});
