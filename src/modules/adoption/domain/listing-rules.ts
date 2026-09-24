// Listing status validation — pure predicates, no DB, no Next.js imports.
// Consolidates the four call sites in app/actions/adoption-listing.ts.

import type { PetListingSnapshot } from "./types";

export type ListingRuleResult = { ok: true } | { ok: false; error: string };

/**
 * Guards that must pass before a pet can be published to the adoption listing.
 * Implements D18 (not lost/deceased), D19 (eligible=true), D20 (no dispute), D21 (no rabies).
 */
export function validatePublish(pet: PetListingSnapshot): ListingRuleResult {
  if (pet.status === "lost") {
    return {
      ok: false,
      error: "Esta mascota está reportada como perdida. Marcala recuperada antes de publicar.",
    };
  }

  if (pet.status === "deceased") {
    return { ok: false, error: "Esta mascota está registrada como fallecida." };
  }

  if (pet.adoptionEligible !== true) {
    return {
      ok: false,
      error:
        "Marcá esta mascota como apta para adopción antes de publicar (desde la pestaña de elegibilidad).",
    };
  }

  if (pet.inCustodyDispute === true) {
    return {
      ok: false,
      error: "Esta mascota está en disputa de custodia. Resolvé la dispute antes de publicar.",
    };
  }

  if (pet.rabiesObservationStatus === "in_progress") {
    return {
      ok: false,
      error:
        "Esta mascota está en período de observación sanitaria. Esperá al cierre del período antes de publicar.",
    };
  }

  return { ok: true };
}

/**
 * Guards for pause: the pet must already have a listing.
 */
export function validatePause(pet: PetListingSnapshot): ListingRuleResult {
  if (!pet.adoptionListedAt) {
    return { ok: false, error: "La mascota no está publicada — pausar no aplica." };
  }
  return { ok: true };
}

/**
 * Guards for unpause: re-validates the cross-spec guards because the pet's
 * state may have changed while it was paused.
 */
export function validateUnpause(pet: PetListingSnapshot): ListingRuleResult {
  if (pet.adoptionEligible !== true) {
    return {
      ok: false,
      error: "Antes de reanudar, marcá esta mascota como apta para adopción.",
    };
  }

  if (pet.inCustodyDispute === true) {
    return {
      ok: false,
      error: "Hay una disputa de custodia en curso. Resolvé antes de reanudar.",
    };
  }

  if (pet.rabiesObservationStatus === "in_progress") {
    return {
      ok: false,
      error: "Período de observación sanitaria activo. Esperá al cierre.",
    };
  }

  return { ok: true };
}

/**
 * Unpublish is always valid — no guards apply.
 */
export function validateUnpublish(_pet: PetListingSnapshot): ListingRuleResult {
  return { ok: true };
}

/**
 * Convenience: checks whether a pet + org pair passes all listability criteria.
 * This mirrors the inline predicate in adoption-applications.ts (isListable).
 * Pure — receives snapshots, no DB.
 */
export function isListable(
  pet: {
    adoptionListedAt: Date | null;
    adoptionListingPausedAt: Date | null;
    status: string;
    adoptionEligible: boolean | null;
    inCustodyDispute: boolean | null;
    rabiesObservationStatus: string | null;
  },
  org: { verified: boolean; orgType: string },
): boolean {
  return (
    pet.adoptionListedAt !== null &&
    pet.adoptionListingPausedAt === null &&
    pet.status !== "deceased" &&
    pet.status !== "lost" &&
    pet.adoptionEligible === true &&
    pet.inCustodyDispute !== true &&
    pet.rabiesObservationStatus !== "in_progress" &&
    org.verified &&
    (org.orgType === "shelter" || org.orgType === "rescue_network")
  );
}

/**
 * Where the animal LIVES, for a listing whose custodian org is `custodianOrgId`
 * (rehome-by-titular, spec REQ-12; design R5 — ONE predicate, never one per
 * surface). True only when the pet's open sponsorship belongs to THAT org: a
 * started event left unmatched over a custody row another org now holds (an
 * intake after drift) must not put "vive con su familia" on an animal sitting
 * in a shelter. `open` is adoption's own spine predicate —
 * `findOpenSponsorship` / `listOpenSponsorships` in
 * infrastructure/rehome-sponsorship-writer.ts.
 */
export function livesWithFamilyUnder(
  open: { sponsoringOrganizationId: string } | null | undefined,
  custodianOrgId: string | null | undefined,
): boolean {
  return open != null && custodianOrgId != null && open.sponsoringOrganizationId === custodianOrgId;
}
