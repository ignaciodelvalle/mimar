// Tests for confidence tier integration in the owner dashboard (plan §A.6).
//
// The vaccination history widget shows a confidence badge per entry.
// This test verifies that the confidence tier is correctly derived from
// the vaccination event's provenance fields.

import { type ConfidenceTier, computeConfidence } from "@/lib/events/event-confidence";
import { describe, expect, it } from "vitest";

// The provenance shape of a vaccination event (author_role / author_verified /
// author_organization_id). It used to mirror VaccinationHistoryRow in
// owner-dashboard.ts; that reader was dead and was deleted (A01-5, 2026-09-18).
type VaccinationProvenanceInput = {
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
};

function vaccinationConfidenceTier(input: VaccinationProvenanceInput): ConfidenceTier {
  return computeConfidence(input);
}

describe("owner dashboard vaccination confidence tier (A.6)", () => {
  it("vet-administered vaccination → professional_verified", () => {
    expect(
      vaccinationConfidenceTier({
        authorRole: "vet",
        authorVerified: true,
        authorOrganizationId: null,
        payload: { vaccine_name: "Triple felina" },
      }),
    ).toBe("professional_verified");
  });

  it("shelter-administered vaccination → institutional_verified", () => {
    expect(
      vaccinationConfidenceTier({
        authorRole: "shelter",
        authorVerified: true,
        authorOrganizationId: "org-refugio",
        payload: { vaccine_name: "Antirrábica" },
      }),
    ).toBe("institutional_verified");
  });

  it("owner-self-reported vaccination → self_reported", () => {
    expect(
      vaccinationConfidenceTier({
        authorRole: "owner",
        authorVerified: false,
        authorOrganizationId: null,
        payload: { vaccine_name: "Antirrábica" },
      }),
    ).toBe("self_reported");
  });

  it("vaccination with confirmed_by_lab → institutional_verified (A4 bumper)", () => {
    expect(
      vaccinationConfidenceTier({
        authorRole: "owner",
        authorVerified: false,
        authorOrganizationId: null,
        payload: { vaccine_name: "Antirrábica", confirmed_by_lab: true },
      }),
    ).toBe("institutional_verified");
  });

  it("VaccinationHistoryRow extended with confidenceTier field should be a valid ConfidenceTier", () => {
    // This is a structural test ensuring our augmented type works correctly
    const tier = vaccinationConfidenceTier({
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: null,
      payload: {},
    });
    const validTiers: ConfidenceTier[] = [
      "institutional_verified",
      "professional_verified",
      "corroborated",
      "self_reported",
      "unverified",
    ];
    expect(validTiers).toContain(tier);
  });
});
