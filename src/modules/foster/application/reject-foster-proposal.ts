// Use-case: reject a foster proposal (volunteer side).
//
// Migrated from app/actions/foster-proposals.ts::rejectFosterProposalAction.
// Auth (session user = proposal.volunteerUserId) is handled by the caller.
//
// Orchestrates:
//   1. Validate rejectionReason (domain rules)
//   2. Load proposal → ownership check → pending guard
//   3. Atomic tx: repo.insertRejectFosterProposal (update + event + close case)
//   4. Collect post-tx org coordinator notifications
//   5. Return UseCaseResult with ok + revalidatePath + notifications

import { validateRejectionReason } from "../domain/proposal-rules";
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

export type RejectFosterProposalInput = {
  proposalPublicToken: string;
  rejectionReason: string;
  responseNotes?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function rejectFosterProposal(
  input: RejectFosterProposalInput,
  deps: Deps,
): Promise<UseCaseResult<{ ok: true; revalidatePath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Validate rejection reason (domain rules).
  const reasonValidation = validateRejectionReason(input.rejectionReason);
  if (!reasonValidation.ok) {
    return { ok: false, error: reasonValidation.error };
  }
  const rejectionReason = reasonValidation.value;

  // 2. Load proposal.
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

  const pendingNotifications: NewNotification[] = [];
  let orgCoordinatorIds: string[] = [];

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const result = await repo.insertRejectFosterProposal(
        {
          proposal,
          rejectionReason,
          responseNotes: input.responseNotes?.trim() || null,
          actorUserId: user.id,
          now: new Date(),
        },
        tx as Parameters<typeof repo.insertRejectFosterProposal>[1],
      );
      orgCoordinatorIds = result.orgCoordinatorIds;
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo rechazar la propuesta.",
    };
  }

  // 4. Collect post-tx notifications for org coordinators.
  const orgToken = await repo.orgPublicTokenById(proposal.organizationId);
  for (const uid of orgCoordinatorIds) {
    pendingNotifications.push({
      userId: uid,
      notificationType: "foster_proposal_rejected_org",
      severity: "info",
      title: "Una propuesta de tránsito fue rechazada",
      body: `Motivo: ${rejectionReason}. Probá con otro voluntario del pool.`,
      relatedPetId: proposal.petId,
      ctaLabel: "Ver propuestas",
      ctaUrl: orgToken ? `/org/${orgToken}/voluntarios/propuestas` : "/org",
    });
  }

  return {
    ok: true,
    value: { ok: true, revalidatePath: "/cuenta/transitos/propuestas" },
    notifications: pendingNotifications,
  };
}
