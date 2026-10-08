// Tests for confidence tier integration in the owner dashboard (plan §A.6).
//
// The vaccination history widget shows a confidence badge per entry.
// This test verifies that the confidence tier is correctly derived from
// the vaccination event's provenance fields.

import { fetchVaccinationSummariesForPets } from "@/lib/analytics/owner-dashboard";
import { type ConfidenceTier, computeConfidence } from "@/lib/events/event-confidence";
import { describe, expect, it, vi } from "vitest";

// The vaccination-summary loader reads through `db.select`; everything else in
// `@/db` (the table objects the query names) stays real.
const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  db: { select: mockSelect },
}));

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

// QA v14 review: the card's summary loader selected no author columns, so every
// dose had no provenance and an owner-declared one counted as "Vigente" — the
// credential front calls the same dose "Declarada".
describe("fetchVaccinationSummariesForPets — a declared dose is not Vigente", () => {
  function selectReturning(rows: unknown[]) {
    const fields: string[][] = [];
    mockSelect.mockImplementation((f?: Record<string, unknown>) => {
      fields.push(Object.keys(f ?? {}));
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: async () => rows,
      };
      return chain;
    });
    return fields;
  }

  const dose = (authorRole: string, authorVerified: boolean) => ({
    id: `ev-${authorRole}`,
    petId: "pet-1",
    eventType: "vaccination_administered",
    payload: { vaccine_name: "Antirrábica" },
    occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    authorRole,
    authorVerified,
    authorOrganizationId: null,
  });

  it("reads the author columns and counts an owner-declared current dose as declared", async () => {
    const fields = selectReturning([dose("owner", false)]);
    const summaries = await fetchVaccinationSummariesForPets([{ petId: "pet-1", species: "dog" }]);
    expect(fields[0]).toEqual(
      expect.arrayContaining(["authorRole", "authorVerified", "authorOrganizationId"]),
    );
    const summary = summaries.get("pet-1");
    expect(summary?.declared).toBe(1);
    expect(summary?.perVaccine.find((v) => v.vaccineName === "Antirrábica")?.provenance).toBe(
      "declarada",
    );
  });

  it("a vet-signed dose stays Vigente", async () => {
    selectReturning([dose("vet", true)]);
    const summary = (
      await fetchVaccinationSummariesForPets([{ petId: "pet-1", species: "dog" }])
    ).get("pet-1");
    expect(summary?.declared).toBe(0);
    expect(summary?.active).toBe(1);
  });
});
