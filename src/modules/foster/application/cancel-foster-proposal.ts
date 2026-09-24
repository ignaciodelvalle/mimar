// Use-case: cancel a foster proposal (org side).
//
// Migrated from app/actions/foster-proposals.ts::cancelFosterProposalAction.
// Auth (foster.assign cap via proposal.organizationId) is handled by the CALLER
// (thin action) BEFORE calling this use-case. The original code did auth inside
// the tx — the refactor moves it to the action edge (design §parity quirk 7).
//
// Orchestrates:
//   1. Load proposal by public token
//   2. Guard: must be pending
//   3. Atomic tx: repo.insertCancelFosterProposal (update + event + close case)
//   4. Collect post-tx volunteer notification
//   5. Return UseCaseResult with ok + notifications

import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: { id: string };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type CancelFosterProposalInput = {
  proposalPublicToken: string;
  cancellationReason?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function cancelFosterProposal(
  input: CancelFosterProposalInput,
  deps: Deps,
): Promise<UseCaseResult<{ ok: true }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load proposal.
  const proposal = await repo.findProposalByToken(input.proposalPublicToken);
  if (!proposal) {
    return { ok: false, error: "Propuesta no encontrada." };
  }

  // 2. Must be pending.
  if (proposal.status !== "pending") {
    return { ok: false, error: "Esta propuesta ya no está activa." };
  }

  const cancellationReason = input.cancellationReason?.trim() || "org_cancelled";
  const pendingNotifications: NewNotification[] = [];

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const { volunteerUserId } = await repo.insertCancelFosterProposal(
        {
          proposal,
          cancellationReason,
          actorUserId: user.id,
          now: new Date(),
        },
        tx as Parameters<typeof repo.insertCancelFosterProposal>[1],
      );

      pendingNotifications.push({
        userId: volunteerUserId,
        notificationType: "foster_proposal_cancelled_volunteer",
        severity: "info",
        title: "Una propuesta de tránsito fue cancelada",
        body: "La organización canceló la propuesta antes de tu respuesta.",
        relatedPetId: proposal.petId,
        ctaLabel: "Ver propuestas",
        ctaUrl: "/cuenta/transitos/propuestas",
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo cancelar la propuesta: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return { ok: true, value: { ok: true }, notifications: pendingNotifications };
}
