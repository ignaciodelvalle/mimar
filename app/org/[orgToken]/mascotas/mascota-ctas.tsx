// Pure CTA-ranking helper for OrgMascotasBulkList (Ola 4 / decision-density
// audit, 2026-07-21). Extracted into its own module (no "use client", no
// server-action imports) so the ranking logic is unit-testable without
// pulling in bulk-pet-events.ts's module-scope `db` import.
//
// A shelter_custody pet could show up to 6 equal-weight outlined CTAs in one
// flat row — no primary/secondary distinction. This ranks them by how
// urgent/likely the NEXT action is for that pet's lifecycle stage; the
// caller renders candidates[0] (if present) as the sole primary CTA and the
// rest in a "Más" overflow. Ranking, most urgent first:
//   1. Devolver al dueño — reunification always outranks the adoption pipeline.
//   2. Cerrar tránsito — an open foster placement is time-sensitive.
//   3. Finalizar adopción — closing a completed adoption.
//   4. Publicar en adopción — the main pipeline action once eligible.
//   5. Elegibilidad — gatekeeper step before listing.
//   6. Asignar tránsito — alternative custody path.
//   7. Transferir — lateral move, least urgent of the set.

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

export type PetCardData = {
  petId: string;
  publicToken: string;
  name: string;
  species: string;
  breed: string | null;
  color: string | null;
  dateOfBirth: string | null;
  birthDateIsEstimated: boolean;
  status: string;
  adoptionEligible: boolean | null;
  adoptionListedAt: string | null;
  adoptionListingPausedAt: string | null;
  ownershipRole: string;
  startedAt: string;
};

// One primary accent for the whole org portal (one-primary-per-screen review,
// 2026-08-06). "Finalizar adopción" used to render green here while the same
// verb was azul elsewhere; green is now reserved for the affirmative half of a
// confirm/decline pair (Aceptar custodia, Aprobar postulación, Confirmar
// publicación), which no card CTA is — every one of them only NAVIGATES.
export type CtaTone = "azul";

/**
 * The three adoption-listing states, named ONCE. The bulk list said "Pausada"
 * while the pet detail page said "Adopción · Pausada" for the identical state,
 * so the operator saw two different names for one thing on two screens of the
 * same portal. Kept here because this module is dependency-free (no
 * "use client", no server actions), so the detail page — a Server Component —
 * can import it without pulling a client boundary across.
 *
 * "Publicada" carries a check icon at both call sites, which is why it is the
 * bare word rather than the whole node: the icon is presentation, the word is
 * the shared vocabulary.
 */
export const ADOPTION_LISTING_LABELS = {
  listed: "Publicada",
  paused: "Pausada",
  unlisted: "Publicar en adopción",
} as const;

export type CtaCandidate = {
  key: string;
  href: string;
  label: ReactNode;
  tone: CtaTone;
};

export type MascotaCtaFlags = {
  canIntake: boolean;
  canAssignFoster: boolean;
  canEndFoster: boolean;
  canFinalizeAdoption: boolean;
  canTransfer: boolean;
  canReturnToOwner: boolean;
  canManageAdoptionListing: boolean;
  hasFoster: boolean;
  hasPendingProposal: boolean;
};

/**
 * Returns the pet card's applicable CTAs, already ranked most-urgent-first.
 * `result[0]` (if present) is the primary action; the rest are secondary.
 */
export function buildMascotaCtas(
  card: PetCardData,
  orgToken: string,
  flags: MascotaCtaFlags,
): CtaCandidate[] {
  const showFosterCta =
    flags.canAssignFoster && card.ownershipRole === "shelter_custody" && !flags.hasFoster;
  const showTransferCta =
    flags.canTransfer &&
    (card.ownershipRole === "shelter_custody" || card.ownershipRole === "owner");
  const showReturnToOwnerCta =
    flags.canReturnToOwner &&
    card.ownershipRole === "shelter_custody" &&
    card.status === "lost" &&
    !flags.hasPendingProposal;

  const candidates: Array<CtaCandidate & { show: boolean }> = [
    {
      key: "return-to-owner",
      show: showReturnToOwnerCta,
      href: `/org/${orgToken}/mascotas/${card.publicToken}?sheet=devolver-al-dueno`,
      label: "Devolver al dueño",
      tone: "azul",
    },
    {
      key: "end-foster",
      show: flags.canEndFoster && flags.hasFoster,
      href: `/org/${orgToken}/mascotas/${card.publicToken}?sheet=fin-transito`,
      label: "Cerrar tránsito",
      tone: "azul",
    },
    {
      key: "finalize-adoption",
      show: flags.canFinalizeAdoption && card.ownershipRole === "shelter_custody",
      href: `/org/${orgToken}/mascotas/${card.publicToken}/adoption`,
      label: "Finalizar adopción",
      tone: "azul",
    },
    {
      key: "publish-listing",
      show: flags.canManageAdoptionListing && card.ownershipRole === "shelter_custody",
      href: `/org/${orgToken}/mascotas/${card.publicToken}/adoptar`,
      label:
        card.adoptionListedAt && !card.adoptionListingPausedAt ? (
          <span className="inline-flex items-center gap-1">
            {ADOPTION_LISTING_LABELS.listed} <Icon name="check" size={13} decorative />
          </span>
        ) : card.adoptionListedAt && card.adoptionListingPausedAt ? (
          ADOPTION_LISTING_LABELS.paused
        ) : (
          ADOPTION_LISTING_LABELS.unlisted
        ),
      tone: "azul",
    },
    {
      key: "eligibility",
      show: flags.canIntake && card.ownershipRole === "shelter_custody",
      href: `/org/${orgToken}/mascotas/${card.publicToken}?sheet=elegibilidad`,
      label:
        card.adoptionEligible === true ? (
          <span className="inline-flex items-center gap-1">
            Apta <Icon name="check" size={13} decorative />
          </span>
        ) : card.adoptionEligible === false ? (
          "NO apta"
        ) : (
          "Elegibilidad"
        ),
      tone: "azul",
    },
    {
      key: "assign-foster",
      show: showFosterCta,
      href: `/org/${orgToken}/mascotas/${card.publicToken}/foster`,
      label: "Asignar tránsito",
      tone: "azul",
    },
    {
      key: "transfer",
      show: showTransferCta,
      href: `/org/${orgToken}/mascotas/${card.publicToken}/transfer`,
      label: "Transferir",
      tone: "azul",
    },
  ];

  return candidates.filter((c) => c.show).map(({ show: _show, ...c }) => c);
}
