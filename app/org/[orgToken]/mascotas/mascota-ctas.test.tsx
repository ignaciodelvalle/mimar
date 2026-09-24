// @vitest-environment jsdom
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { type MascotaCtaFlags, type PetCardData, buildMascotaCtas } from "./mascota-ctas";

// Ola 4 / decision-density audit (2026-07-21): OrgMascotasBulkList could show
// up to 6 equal-weight outlined CTAs on one pet card, with no way to tell
// which one mattered. buildMascotaCtas ranks the applicable actions so the
// caller can render candidates[0] as the sole primary CTA and the rest as a
// "Más" overflow — these tests pin the ranking, not just the rendering.

const BASE_CARD: PetCardData = {
  petId: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Firulais",
  species: "dog",
  breed: null,
  color: null,
  dateOfBirth: null,
  birthDateIsEstimated: false,
  status: "active",
  adoptionEligible: null,
  adoptionListedAt: null,
  adoptionListingPausedAt: null,
  ownershipRole: "shelter_custody",
  startedAt: "2026-01-01T00:00:00.000Z",
};

const NO_FLAGS: MascotaCtaFlags = {
  canIntake: false,
  canAssignFoster: false,
  canEndFoster: false,
  canFinalizeAdoption: false,
  canTransfer: false,
  canReturnToOwner: false,
  canManageAdoptionListing: false,
  hasFoster: false,
  hasPendingProposal: false,
};

function labelText(node: ReactNode) {
  const { container } = render(<div>{node}</div>);
  return container.textContent ?? "";
}

describe("buildMascotaCtas", () => {
  it("returns no CTAs when nothing is granted", () => {
    expect(buildMascotaCtas(BASE_CARD, "org1", NO_FLAGS)).toEqual([]);
  });

  it("ranks Devolver al dueño above every other applicable action (reunification wins)", () => {
    const card: PetCardData = { ...BASE_CARD, status: "lost" };
    const result = buildMascotaCtas(card, "org1", {
      ...NO_FLAGS,
      canReturnToOwner: true,
      canFinalizeAdoption: true,
      canManageAdoptionListing: true,
      canIntake: true,
      canAssignFoster: true,
      canTransfer: true,
    });

    expect(result[0].key).toBe("return-to-owner");
    expect(labelText(result[0].label)).toBe("Devolver al dueño");
    // The rest are still present, just demoted to secondary.
    expect(result.slice(1).map((c) => c.key)).toEqual([
      "finalize-adoption",
      "publish-listing",
      "eligibility",
      "assign-foster",
      "transfer",
    ]);
  });

  it("does not offer Devolver al dueño when the pet isn't lost", () => {
    const result = buildMascotaCtas(BASE_CARD, "org1", {
      ...NO_FLAGS,
      canReturnToOwner: true,
      canTransfer: true,
    });
    expect(result.map((c) => c.key)).toEqual(["transfer"]);
  });

  it("ranks Cerrar tránsito above the adoption-pipeline actions when a foster is active", () => {
    const result = buildMascotaCtas(BASE_CARD, "org1", {
      ...NO_FLAGS,
      canEndFoster: true,
      hasFoster: true,
      canFinalizeAdoption: true,
      canManageAdoptionListing: true,
    });
    expect(result[0].key).toBe("end-foster");
  });

  it("does not offer Asignar tránsito once the pet already has an active foster", () => {
    const result = buildMascotaCtas(BASE_CARD, "org1", {
      ...NO_FLAGS,
      canAssignFoster: true,
      hasFoster: true,
    });
    expect(result).toEqual([]);
  });

  it("the 6-simultaneous-CTA case (audit's worst offender): exactly one primary, five secondary, in rank order", () => {
    const card: PetCardData = { ...BASE_CARD, status: "lost" };
    const result = buildMascotaCtas(card, "org1", {
      canIntake: true,
      canAssignFoster: true,
      canEndFoster: false,
      canFinalizeAdoption: true,
      canTransfer: true,
      canReturnToOwner: true,
      canManageAdoptionListing: true,
      hasFoster: false,
      hasPendingProposal: false,
    });

    expect(result).toHaveLength(6);
    expect(result[0].key).toBe("return-to-owner");
    expect(result.map((c) => c.key)).toEqual([
      "return-to-owner",
      "finalize-adoption",
      "publish-listing",
      "eligibility",
      "assign-foster",
      "transfer",
    ]);
  });

  it("reflects listing state in the Publicar en adopción label", () => {
    const published: PetCardData = {
      ...BASE_CARD,
      adoptionListedAt: "2026-01-01T00:00:00.000Z",
      adoptionListingPausedAt: null,
    };
    const result = buildMascotaCtas(published, "org1", {
      ...NO_FLAGS,
      canManageAdoptionListing: true,
    });
    expect(labelText(result[0].label)).toContain("Publicada");
  });

  it("builds hrefs scoped to the org token and pet public token", () => {
    const result = buildMascotaCtas(BASE_CARD, "acme", {
      ...NO_FLAGS,
      canTransfer: true,
    });
    expect(result[0].href).toBe("/org/acme/mascotas/DIM-TEST-0001/transfer");
  });
});
