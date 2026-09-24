import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_ORDER,
  type ConfidenceTier,
  computeConfidence,
  confidenceLabel,
  isAtLeast,
} from "./event-confidence";

// ---------------------------------------------------------------------------
// Helper factory for minimal ConfidenceInput objects.
// ---------------------------------------------------------------------------

function input(
  overrides: Partial<{
    authorRole: string;
    authorVerified: boolean;
    authorOrganizationId: string | null;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    authorRole: overrides.authorRole ?? "owner",
    authorVerified: overrides.authorVerified ?? false,
    authorOrganizationId: overrides.authorOrganizationId ?? null,
    payload: overrides.payload ?? {},
  };
}

// ---------------------------------------------------------------------------
// computeConfidence — truth table
// ---------------------------------------------------------------------------

describe("computeConfidence", () => {
  // --- shelter ---
  it("shelter verified with org → institutional_verified", () => {
    expect(
      computeConfidence(
        input({ authorRole: "shelter", authorVerified: true, authorOrganizationId: "org-1" }),
      ),
    ).toBe("institutional_verified");
  });

  it("shelter verified WITHOUT org → self_reported (no org = can't claim institutional)", () => {
    // Without an org ID the shelter verification is incomplete — treated as self_reported
    expect(computeConfidence(input({ authorRole: "shelter", authorVerified: true }))).toBe(
      "self_reported",
    );
  });

  // VET-role trust keystone (#43): an org member WITHOUT a validated matrícula
  // signs as shelter+org+!verified. It is a valid institutional record but NOT
  // professional verification — org_registered, which never clears the "al día"
  // compliance gate. This is the tier that closes the "verificado" theater (#45).
  it("shelter unverified with org → org_registered (recorded, not verified)", () => {
    expect(
      computeConfidence(
        input({ authorRole: "shelter", authorVerified: false, authorOrganizationId: "org-1" }),
      ),
    ).toBe("org_registered");
  });

  it("org_registered ranks below professional_verified (never clears the verified gate)", () => {
    expect(isAtLeast("org_registered", "professional_verified")).toBe(false);
    expect(isAtLeast("org_registered", "corroborated")).toBe(true);
  });

  // --- govt ---
  it("govt verified → institutional_verified", () => {
    expect(computeConfidence(input({ authorRole: "govt", authorVerified: true }))).toBe(
      "institutional_verified",
    );
  });

  it("govt unverified → self_reported", () => {
    expect(computeConfidence(input({ authorRole: "govt", authorVerified: false }))).toBe(
      "self_reported",
    );
  });

  // --- vet ---
  it("vet verified → professional_verified", () => {
    expect(computeConfidence(input({ authorRole: "vet", authorVerified: true }))).toBe(
      "professional_verified",
    );
  });

  it("vet unverified → self_reported (treated as owner-equivalent until matriculation)", () => {
    expect(computeConfidence(input({ authorRole: "vet", authorVerified: false }))).toBe(
      "self_reported",
    );
  });

  // --- owner ---
  it("owner with evidence_hash → corroborated", () => {
    expect(
      computeConfidence(input({ authorRole: "owner", payload: { evidence_hash: "sha256-abc" } })),
    ).toBe("corroborated");
  });

  it("owner with matched_chip_number → corroborated", () => {
    expect(
      computeConfidence(
        input({ authorRole: "owner", payload: { matched_chip_number: "900006000000001" } }),
      ),
    ).toBe("corroborated");
  });

  it("owner with microchip_confirmed=true → corroborated", () => {
    expect(
      computeConfidence(input({ authorRole: "owner", payload: { microchip_confirmed: true } })),
    ).toBe("corroborated");
  });

  it("owner alone (no evidence) → self_reported", () => {
    expect(computeConfidence(input({ authorRole: "owner" }))).toBe("self_reported");
  });

  it("owner verified (but no extra evidence) → self_reported", () => {
    // authorVerified on owner role has no effect on its own — they need evidence
    expect(computeConfidence(input({ authorRole: "owner", authorVerified: true }))).toBe(
      "self_reported",
    );
  });

  // --- scanner ---
  it("scanner → unverified", () => {
    expect(computeConfidence(input({ authorRole: "scanner" }))).toBe("unverified");
  });

  // --- unknown / system ---
  it("unknown authorRole falls back to self_reported", () => {
    expect(computeConfidence(input({ authorRole: "unknown_future_role" }))).toBe("self_reported");
  });

  // --- A4 bumper: confirmed_by_lab overrides everything ---
  it("vet unverified with confirmed_by_lab=true → institutional_verified (A4 bumper)", () => {
    expect(
      computeConfidence(
        input({ authorRole: "vet", authorVerified: false, payload: { confirmed_by_lab: true } }),
      ),
    ).toBe("institutional_verified");
  });

  it("owner with confirmed_by_lab=true → institutional_verified (A4 bumper)", () => {
    expect(
      computeConfidence(input({ authorRole: "owner", payload: { confirmed_by_lab: true } })),
    ).toBe("institutional_verified");
  });

  it("scanner with confirmed_by_lab=true → institutional_verified (A4 bumper)", () => {
    expect(
      computeConfidence(input({ authorRole: "scanner", payload: { confirmed_by_lab: true } })),
    ).toBe("institutional_verified");
  });

  it("confirmed_by_lab=false does NOT trigger bumper", () => {
    expect(
      computeConfidence(input({ authorRole: "owner", payload: { confirmed_by_lab: false } })),
    ).toBe("self_reported");
  });
});

// ---------------------------------------------------------------------------
// isAtLeast
// ---------------------------------------------------------------------------

describe("isAtLeast", () => {
  it("institutional_verified is at least institutional_verified", () => {
    expect(isAtLeast("institutional_verified", "institutional_verified")).toBe(true);
  });

  it("institutional_verified is at least professional_verified", () => {
    expect(isAtLeast("institutional_verified", "professional_verified")).toBe(true);
  });

  it("institutional_verified is at least unverified", () => {
    expect(isAtLeast("institutional_verified", "unverified")).toBe(true);
  });

  it("professional_verified is NOT at least institutional_verified", () => {
    expect(isAtLeast("professional_verified", "institutional_verified")).toBe(false);
  });

  it("self_reported is NOT at least corroborated", () => {
    expect(isAtLeast("self_reported", "corroborated")).toBe(false);
  });

  it("unverified is at least unverified", () => {
    expect(isAtLeast("unverified", "unverified")).toBe(true);
  });

  it("CONFIDENCE_ORDER has 6 distinct tiers in ascending order", () => {
    expect(CONFIDENCE_ORDER).toHaveLength(6);
    const tiers: ConfidenceTier[] = [
      "unverified",
      "self_reported",
      "corroborated",
      "org_registered",
      "professional_verified",
      "institutional_verified",
    ];
    expect(CONFIDENCE_ORDER).toEqual(tiers);
  });
});

// ---------------------------------------------------------------------------
// confidenceLabel — A7: descriptive, not judgmental
// ---------------------------------------------------------------------------

describe("confidenceLabel", () => {
  it("institutional_verified → es-AR label about institution", () => {
    const label = confidenceLabel("institutional_verified");
    expect(label.length).toBeGreaterThan(0);
    // Must not say "high confidence" — must be descriptive
    expect(label.toLowerCase()).not.toContain("high confidence");
    expect(label.toLowerCase()).not.toContain("alta confianza");
    // Should describe the source
    expect(label).toBe("Verificado institucionalmente");
  });

  it("professional_verified → es-AR label about veterinarian", () => {
    expect(confidenceLabel("professional_verified")).toBe("Verificado por veterinario matriculado");
  });

  it("org_registered → es-AR label about the organization (record, not verification)", () => {
    const label = confidenceLabel("org_registered");
    expect(label).toBe("Registrado por la organización");
    // Must NOT read as professional/institutional verification.
    expect(label.toLowerCase()).not.toContain("verificado");
  });

  it("corroborated → es-AR label about evidence", () => {
    expect(confidenceLabel("corroborated")).toBe("Autorreportado con evidencia");
  });

  it("self_reported → es-AR label about owner", () => {
    expect(confidenceLabel("self_reported")).toBe("Reportado por el dueño");
  });

  it("unverified → es-AR label neutral", () => {
    expect(confidenceLabel("unverified")).toBe("Sin verificar");
  });
});
