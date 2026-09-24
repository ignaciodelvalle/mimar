import { describe, expect, it } from "vitest";

import type { ConfidenceTier } from "@/lib/events/event-confidence";
import { ownerConfidenceDisplay } from "@/lib/projections/owner-confidence-display";

describe("ownerConfidenceDisplay — 5 tiers collapse to 3 owner badges", () => {
  const cases: Array<[ConfidenceTier, string, string]> = [
    ["institutional_verified", "Verificado · oficial", "success"],
    ["professional_verified", "Verificado por vet", "info"],
    ["corroborated", "Registrado por vos", "neutral"],
    ["self_reported", "Registrado por vos", "neutral"],
    ["unverified", "Sin verificar", "warning"],
  ];

  for (const [tier, label, badge] of cases) {
    it(`${tier} → "${label}" (${badge})`, () => {
      const display = ownerConfidenceDisplay(tier);
      expect(display.label).toBe(label);
      expect(display.badge).toBe(badge);
    });
  }

  it("corroborated and self_reported share the neutral 'Registrado por vos' badge", () => {
    expect(ownerConfidenceDisplay("corroborated")).toEqual(ownerConfidenceDisplay("self_reported"));
  });
});
