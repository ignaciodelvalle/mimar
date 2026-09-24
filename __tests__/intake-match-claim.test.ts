// Unit tests for the intake-match claim token (review 24 HIGH #6/#7).
//
// Pure crypto — no DB, no auth. Mirrors the force-token utility tests in
// chip-match.test.ts. The claim binds (orgToken, matchedPetToken); a claim for
// a different org or a different pet must NOT validate, which is the mechanism
// that closes the cross-tenant intake-match PII leak.

import { describe, expect, it } from "vitest";

import { generateIntakeMatchClaim, validateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";

const ORG_A = "DIM-ORGA-0001";
const ORG_B = "DIM-ORGB-0002";
const PET_X = "DIM-PETX-0001";
const PET_Y = "DIM-PETY-0002";

describe("intake-match claim: generate / validate", () => {
  it("a fresh claim validates for its own (org, pet) pair", () => {
    const claim = generateIntakeMatchClaim(ORG_A, PET_X);
    expect(validateIntakeMatchClaim(ORG_A, PET_X, claim)).toBe(true);
  });

  it("a claim for org A does NOT validate for org B (same pet)", () => {
    const claim = generateIntakeMatchClaim(ORG_A, PET_X);
    expect(validateIntakeMatchClaim(ORG_B, PET_X, claim)).toBe(false);
  });

  it("a claim for pet X does NOT validate for pet Y (same org)", () => {
    const claim = generateIntakeMatchClaim(ORG_A, PET_X);
    expect(validateIntakeMatchClaim(ORG_A, PET_Y, claim)).toBe(false);
  });

  it("a tampered claim fails validation", () => {
    const claim = generateIntakeMatchClaim(ORG_A, PET_X);
    const tampered = `${claim.slice(0, -5)}XXXXX`;
    expect(validateIntakeMatchClaim(ORG_A, PET_X, tampered)).toBe(false);
  });

  it("malformed / empty claims fail validation", () => {
    expect(validateIntakeMatchClaim(ORG_A, PET_X, "")).toBe(false);
    expect(validateIntakeMatchClaim(ORG_A, PET_X, "not-a-valid-claim")).toBe(false);
    expect(validateIntakeMatchClaim(ORG_A, PET_X, "abc.notanumber")).toBe(false);
  });

  it("an expired claim (simulated) fails validation", () => {
    const fresh = generateIntakeMatchClaim(ORG_A, PET_X);
    const dotIdx = fresh.lastIndexOf(".");
    const macPart = fresh.slice(0, dotIdx);
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;
    const expired = `${macPart}.${thirtyOneMinutesAgo}`;
    expect(validateIntakeMatchClaim(ORG_A, PET_X, expired)).toBe(false);
  });
});
