// Use-case: propose a foster to a volunteer (org side).
//
// Migrated from app/actions/foster-proposals.ts::proposeFosterAction.
// Auth (foster.assign capability via org.id) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Pet lookup (must be in org's shelter_custody)
//   2. D17 co-foster gate (no active foster that blocks co-foster)
//   3. Volunteer validation (enrolled, active, slots > 0)
//   4. Duplicate pending guard
//   5. Match warnings snapshot
//   6. Atomic tx: repo.insertProposeFoster (case + proposal + event)
//   7. Collect post-tx notification for volunteer
//   8. Return UseCaseResult with proposalPublicToken + revalidatePath

import { generatePrefixedToken } from "@/lib/infra/publicToken";
import { ageMonthsFromDob, computeMatch } from "@/src/modules/foster/domain/matching-rules";
import {
  computeProposalExpiresAt,
  isCoFosterBlocked,
  isDuplicatePendingBlocked,
} from "../domain/proposal-rules";
import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type ProposeFosterInput = {
  petPublicToken: string;
  volunteerUserId: string;
  proposedDurationWeeks?: number | null;
  proposedNotes?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function proposeFoster(
  input: ProposeFosterInput,
  deps: Deps,
): Promise<UseCaseResult<{ proposalPublicToken: string; revalidatePath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Pet lookup.
  const petRow = await repo.findShelterPetByToken(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 2. D17 co-foster gate.
  const activeFosterRows = await repo.findActiveFosterRows(petRow.id);
  if (isCoFosterBlocked(activeFosterRows)) {
    return { ok: false, error: "Esta mascota ya tiene tránsito activo y no admite co-foster." };
  }

  // 3. Volunteer validation.
  const volunteer = await repo.findVolunteerByUserId(input.volunteerUserId);
  if (!volunteer) {
    return { ok: false, error: "Este usuario no está inscripto en el pool de voluntarios." };
  }
  if (volunteer.status !== "active") {
    return { ok: false, error: "El voluntario no está activo en el pool." };
  }
  if (volunteer.availableSlots <= 0) {
    return { ok: false, error: "Este voluntario no tiene slots disponibles." };
  }

  // 4. Duplicate pending guard.
  const hasDuplicate = await repo.findDuplicatePending(
    organization.id,
    input.volunteerUserId,
    petRow.id,
  );
  if (isDuplicatePendingBlocked(hasDuplicate)) {
    return {
      ok: false,
      error: "Ya tenés una propuesta pendiente para este voluntario y esta mascota.",
    };
  }

  // 5. Match warnings snapshot.
  const pet = petRow as {
    species: string;
    estimatedWeightKg?: number | null;
    dateOfBirth?: Date | null;
    potentiallyDangerousBreed: boolean;
    name: string;
    id: string;
    jurisdictionProvince?: string | null;
    jurisdictionLocality?: string | null;
  };

  const matchPet = {
    species: pet.species,
    estimatedWeightKg: pet.estimatedWeightKg != null ? Number(pet.estimatedWeightKg) : null,
    ageMonths: ageMonthsFromDob(pet.dateOfBirth ?? null),
    isPpp: pet.potentiallyDangerousBreed,
    hasChronic: false,
  };
  const match = computeMatch(matchPet, volunteer, input.proposedDurationWeeks ?? null);
  const warningMessages = match.warnings.map((w) => w.message);

  const now = new Date();
  const expiresAt = computeProposalExpiresAt(now);
  const publicToken = generatePrefixedToken("FP");

  const pendingNotifications: NewNotification[] = [];

  // 6. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.insertProposeFoster(
        {
          petId: pet.id,
          petName: pet.name,
          petJurisdictionProvince: pet.jurisdictionProvince ?? null,
          petJurisdictionLocality: pet.jurisdictionLocality ?? null,
          volunteerUserId: input.volunteerUserId,
          proposedByUserId: user.id,
          orgId: organization.id,
          orgVerified: organization.verified,
          orgDisplayName: organization.displayName,
          orgToken: organization.publicToken,
          publicToken,
          proposedDurationWeeks: input.proposedDurationWeeks ?? null,
          proposedNotes: input.proposedNotes?.trim() || null,
          matchWarnings: warningMessages,
          expiresAt,
          now,
        },
        tx as Parameters<typeof repo.insertProposeFoster>[1],
      );

      pendingNotifications.push({
        userId: input.volunteerUserId,
        notificationType: "foster_proposal_received",
        severity: "warning",
        title: `${organization.displayName} te propuso un tránsito`,
        body: `Mascota: ${pet.name}. Revisá los detalles y aceptá o rechazá.`,
        ctaLabel: "Ver propuesta",
        ctaUrl: `/cuenta/transitos/propuestas/${publicToken}`,
        relatedPetId: pet.id,
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo crear la propuesta: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return {
    ok: true,
    value: {
      proposalPublicToken: publicToken,
      revalidatePath: `/org/${organization.publicToken}/voluntarios/propuestas`,
    },
    notifications: pendingNotifications,
  };
}
