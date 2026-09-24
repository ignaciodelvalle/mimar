// Use-case: cancel an owner→owner pet transfer (sender only).
//
// Migrated from app/actions/pet-transfer.ts::cancelPetTransferAction.
// Auth (requireUserOrRedirect) is handled by the caller.
//
// Orchestrates:
//   1. Load transfer + sender auth check + status check
//   2. ATOMIC tx: updateTransferStatus(cancelled) + collect recipient notification (if toOwnerId set)
//   3. Return UseCaseResult<void> + notifications
//
// PARITY: notifies recipient ONLY IF toOwnerId is set (known account).

import type { TransfersRepository } from "../infrastructure/transfers-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: typeof TransfersRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type CancelPetTransferInput = {
  transferToken: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function cancelPetTransfer(
  input: CancelPetTransferInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load transfer.
  const transfer = await repo.findTransferByToken(input.transferToken);
  if (!transfer) return { ok: false, error: "Transferencia no encontrada." };
  if (transfer.fromOwnerId !== user.id) {
    return { ok: false, error: "Solo el emisor puede cancelar la propuesta." };
  }
  if (transfer.status !== "pending") {
    return { ok: false, error: `La transferencia ya está ${transfer.status}.` };
  }

  const pendingNotifications: NewNotification[] = [];

  // 2. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const now = new Date();
      // Conditional flip: only cancel while still pending. Serializes against a
      // concurrent accept on the same transfer — whichever conditional UPDATE
      // commits first wins; the loser sees zero rows and aborts. Without this,
      // a sender cancelling while the recipient accepts could mark an
      // already-accepted transfer as cancelled.
      const updatedRows = await repo.updateTransferStatus(
        {
          id: transfer.id,
          status: "cancelled",
          respondedAt: now,
          expectedStatus: "pending",
        },
        tx as Parameters<typeof repo.updateTransferStatus>[1],
      );
      if (updatedRows === 0) {
        throw new Error("La transferencia ya no está pendiente.");
      }

      // Parity: notify recipient only if toOwnerId is known.
      if (transfer.toOwnerId) {
        pendingNotifications.push({
          userId: transfer.toOwnerId,
          notificationType: "pet_transfer_cancelled",
          severity: "info",
          title: "Transferencia cancelada",
          body: "El emisor canceló la propuesta antes de que respondieras.",
          relatedPetId: transfer.petId,
          category: "custody",
          // no-cta: the incoming transfer was cancelled before acceptance, so the
          // recipient never gained the pet and there is no transfer/pet surface to open.
        });
      }
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Error desconocido." };
  }

  return { ok: true, value: { petId: transfer.petId }, notifications: pendingNotifications };
}
