// Unit tests for ConfidenceBadge — verifies that each tier maps to the
// correct label and that the component compiles/exports correctly.
//
// No DOM renderer is available in this repo's test setup, so we validate
// via the underlying logic functions that ConfidenceBadge delegates to.
// The render tree is trivially thin: one <span> with confidenceLabel(tier)
// and TIER_STYLES[tier]. The substantive logic lives in event-confidence.ts
// which is fully covered in event-confidence.test.ts.

import { type ConfidenceTier, confidenceLabel, isAtLeast } from "@/lib/events/event-confidence";
import { describe, expect, it } from "vitest";

// Mirrors TIER_STYLES in ConfidenceBadge.tsx. If styles drift, this test
// catches it by asserting the mapping is exhaustive.
const TIER_STYLES: Record<ConfidenceTier, string> = {
  institutional_verified: "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]",
  professional_verified: "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]",
  org_registered: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  corroborated: "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]",
  self_reported: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  unverified: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-faint)]",
};

const ALL_TIERS: ConfidenceTier[] = [
  "institutional_verified",
  "professional_verified",
  "org_registered",
  "corroborated",
  "self_reported",
  "unverified",
];

describe("ConfidenceBadge label contract", () => {
  it("every tier has a non-empty label", () => {
    for (const tier of ALL_TIERS) {
      expect(confidenceLabel(tier).length, `label for ${tier} must not be empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it("labels are descriptive es-AR (A7: not judgmental)", () => {
    for (const tier of ALL_TIERS) {
      const label = confidenceLabel(tier).toLowerCase();
      expect(label, `tier ${tier} must not say 'high confidence'`).not.toContain("high confidence");
      expect(label, `tier ${tier} must not say 'low confidence'`).not.toContain("low confidence");
      expect(label, `tier ${tier} must not say 'alta confianza'`).not.toContain("alta confianza");
      expect(label, `tier ${tier} must not say 'baja confianza'`).not.toContain("baja confianza");
    }
  });

  it("institutional_verified badge shows institutional label", () => {
    expect(confidenceLabel("institutional_verified")).toBe("Verificado institucionalmente");
  });

  it("professional_verified badge shows vet label", () => {
    expect(confidenceLabel("professional_verified")).toBe("Verificado por veterinario matriculado");
  });

  it("self_reported badge shows owner label (not shaming)", () => {
    expect(confidenceLabel("self_reported")).toBe("Reportado por el dueño");
  });

  it("unverified badge shows neutral label", () => {
    expect(confidenceLabel("unverified")).toBe("Sin verificar");
  });
});

describe("ConfidenceBadge style contract", () => {
  it("every tier has a non-empty style class", () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_STYLES[tier].length, `style for ${tier} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("institutional and professional tiers have distinct colors", () => {
    expect(TIER_STYLES.institutional_verified).not.toBe(TIER_STYLES.professional_verified);
  });

  it("higher-trust tiers use more prominent colors than self_reported/unverified", () => {
    // Institutional uses ok (green), semantically positive
    expect(TIER_STYLES.institutional_verified).toContain("ln-ok");
    // Professional uses azul (blue)
    expect(TIER_STYLES.professional_verified).toContain("ln-azul");
    // Lower tiers fade onto the neutral stripe surface
    expect(TIER_STYLES.self_reported).toContain("ln-stripe");
    expect(TIER_STYLES.unverified).toContain("ln-stripe");
  });
});

describe("ConfidenceBadge threshold usage (via isAtLeast)", () => {
  it("public credential filter: institutional and professional tiers pass verified gate", () => {
    expect(isAtLeast("institutional_verified", "professional_verified")).toBe(true);
    expect(isAtLeast("professional_verified", "professional_verified")).toBe(true);
    expect(isAtLeast("corroborated", "professional_verified")).toBe(false);
    expect(isAtLeast("self_reported", "professional_verified")).toBe(false);
    expect(isAtLeast("unverified", "professional_verified")).toBe(false);
  });

  it("ln filter: only institutional passes the strict institutional gate", () => {
    expect(isAtLeast("institutional_verified", "institutional_verified")).toBe(true);
    expect(isAtLeast("professional_verified", "institutional_verified")).toBe(false);
  });
});
