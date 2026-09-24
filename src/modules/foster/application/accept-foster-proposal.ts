// Use-case: accept a foster proposal (volunteer side).
//
// Migrated from app/actions/foster-proposals.ts::acceptFosterProposalAction.
// Auth (session user = proposal.volunteerUserId) is handled by the caller.
//
// Orchestrates:
//   1. Load proposal → ownership check → co-foster re-check → volunteer guard
//   2. Atomic tx: repo.insertAcceptFosterProposal
//      - ownership INSERT FIRST (satisfies CHECK foster_proposals_response_consistent)
//      - single proposal UPDATE with resolvedOwnershipId
//      - emit foster_proposal_resolved (authorVerified=false) + foster_assigned (authorVerified=TRUE)
//      - close foster_proposal case
//      - optional co-foster event
//      - D16 slot decrement
//      - D18 cascade when newSlots===0
//   3. Collect post-tx notifications (accepting org + D18 cascade orgs)
//   4. Return UseCaseResult with fosterOwnershipId, remainingSlots, cascadeCancelledProposals
//
// PARITY QUIRKS:
//   - foster_assigned authorVerified is hardcoded TRUE (design §parity quirk 3)
//   - D18 cascade notifications are flushed post-tx (best-effort)

import { isCoFosterBlocked } from "../domain/proposal-rules";
import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type AcceptFosterProposalInput = {
  proposalPublicToken: string;
  allowCoFoster: boolean;
  responseNotes?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function acceptFosterProposal(
  input: AcceptFosterProposalInput,
  deps: Deps,
): Promise<
  UseCaseResult<{
    fosterOwnershipId: string;
    remainingSlots: number;
    cascadeCancelledProposals: string[];
  }>
> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1a. Load proposal.
  const proposal = await repo.findProposalByToken(input.proposalPublicToken);
  if (!proposal) {
    return { ok: false, error: "Propuesta no encontrada." };
  }
  if (proposal.volunteerUserId !== user.id) {
    return { ok: false, error: "Esta propuesta no es para vos." };
  }
  if (proposal.status !== "pending") {
    return { ok: false, error: "Esta propuesta ya no está activa." };
  }

  // 1b. Re-validate org still has shelter custody (defense-in-depth).
  const orgCustody = await repo.findOrgCustodyByPetId(proposal.petId, proposal.organizationId);
  if (!orgCustody) {
    return { ok: false, error: "La organización ya no tiene custodia de esta mascota." };
  }

  // 1c. D17 co-foster re-check (state may have changed since proposal).
  const activeFosterRows = await repo.findActiveFosterRows(proposal.petId);
  if (isCoFosterBlocked(activeFosterRows)) {
    return {
      ok: false,
      error: "El estado del pet cambió: ahora tiene un tránsito activo que no admite co-foster.",
    };
  }

  // 1d. Volunteer guard.
  const volunteer = await repo.findVolunteerByUserId(user.id);
  if (!volunteer) {
    return { ok: false, error: "No estás inscripto en el pool." };
  }
  if (volunteer.status !== "active") {
    return { ok: false, error: "Tu inscripción no está activa." };
  }
  if (volunteer.availableSlots <= 0) {
    return { ok: false, error: "Ya no tenés slots disponibles." };
  }

  const pendingNotifications: NewNotification[] = [];

  // 2. Atomic transaction.
  let txResult: {
    ownershipId: string;
    newSlots: number;
    cascadeCancelledTokens: string[];
    cascadeOrgNotifyTargets: { orgId: string; petId: string }[];
    acceptingOrgCoordinatorIds: string[];
    actorDisplayName: string | null;
  };
  try {
    txResult = await transaction(async (tx) => {
      return repo.insertAcceptFosterProposal(
        {
          proposal,
          petId: proposal.petId,
          petName: "",
          volunteerUserId: user.id,
          volunteerId: volunteer.id,
          volunteerCurrentSlots: volunteer.availableSlots,
          allowCoFoster: input.allowCoFoster,
          responseNotes: input.responseNotes?.trim() || null,
          actorUserId: user.id,
          actorOrgId: proposal.organizationId,
          now: new Date(),
        },
        tx as Parameters<typeof repo.insertAcceptFosterProposal>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo aceptar la propuesta.",
    };
  }

  const {
    ownershipId,
    newSlots,
    cascadeCancelledTokens,
    cascadeOrgNotifyTargets,
    acceptingOrgCoordinatorIds,
    actorDisplayName,
  } = txResult;

  // 3. Collect post-tx notifications.
  // Accepting org coordinators.
  const acceptingOrgToken = await repo.orgPublicTokenById(proposal.organizationId);
  for (const uid of acceptingOrgCoordinatorIds) {
    pendingNotifications.push({
      userId: uid,
      notificationType: "foster_proposal_accepted_org",
      severity: "success",
      title: `${actorDisplayName ?? "Un voluntario"} aceptó la propuesta de tránsito`,
      body: "Coordiná el handoff con el voluntario.",
      relatedPetId: proposal.petId,
      ctaLabel: "Ver propuestas",
      ctaUrl: acceptingOrgToken ? `/org/${acceptingOrgToken}/voluntarios/propuestas` : "/org",
    });
  }

  // D18 cascade — fan-out to affected org coordinators (post-tx best-effort).
  for (const target of cascadeOrgNotifyTargets) {
    const targetOrgToken = await repo.orgPublicTokenById(target.orgId);
    const coordIds = await repo.orgFosterCoordinatorUserIds(target.orgId);
    for (const uid of coordIds) {
      pendingNotifications.push({
        userId: uid,
        notificationType: "foster_proposal_auto_cancelled_org",
        severity: "info",
        title: "Tu propuesta de tránsito fue auto-cancelada",
        body: "El voluntario aceptó otra propuesta y se quedó sin slots.",
        relatedPetId: target.petId,
        ctaLabel: "Ver propuestas",
        ctaUrl: targetOrgToken ? `/org/${targetOrgToken}/voluntarios/propuestas` : "/org",
      });
    }
  }

  return {
    ok: true,
    value: {
      fosterOwnershipId: ownershipId,
      remainingSlots: newSlots,
      cascadeCancelledProposals: cascadeCancelledTokens,
    },
    notifications: pendingNotifications,
  };
}
