// Tests for the public credential confidence tier gate (plan §A.4).
//
// Decision: the public credential shows a confidence badge ONLY for
// institutional_verified or professional_verified tiers. self_reported,
// corroborated, and unverified are intentionally silent ("no shame on
// the public credential").

import { type ConfidenceTier, isAtLeast } from "@/lib/events/event-confidence";
import { describe, expect, it } from "vitest";

// The gate function used in the public credential page.
// isAtLeast(tier, "professional_verified") → show badge.
function shouldShowCredentialConfidence(tier: ConfidenceTier): boolean {
  return isAtLeast(tier, "professional_verified");
}

describe("public credential confidence gate (A.4)", () => {
  it("institutional_verified → show badge", () => {
    expect(shouldShowCredentialConfidence("institutional_verified")).toBe(true);
  });

  it("professional_verified → show badge", () => {
    expect(shouldShowCredentialConfidence("professional_verified")).toBe(true);
  });

  it("corroborated → NO badge (no shame)", () => {
    expect(shouldShowCredentialConfidence("corroborated")).toBe(false);
  });

  it("self_reported → NO badge (no shame)", () => {
    expect(shouldShowCredentialConfidence("self_reported")).toBe(false);
  });

  it("unverified → NO badge (no shame)", () => {
    expect(shouldShowCredentialConfidence("unverified")).toBe(false);
  });

  it("the gate is isAtLeast(tier, 'professional_verified') — consistent with plan A.4", () => {
    // These two must be equivalent
    const verifiedTiers: ConfidenceTier[] = ["institutional_verified", "professional_verified"];
    const lowerTiers: ConfidenceTier[] = ["corroborated", "self_reported", "unverified"];

    for (const tier of verifiedTiers) {
      expect(isAtLeast(tier, "professional_verified"), `${tier} should pass the gate`).toBe(true);
    }
    for (const tier of lowerTiers) {
      expect(isAtLeast(tier, "professional_verified"), `${tier} should NOT pass the gate`).toBe(
        false,
      );
    }
  });
});
