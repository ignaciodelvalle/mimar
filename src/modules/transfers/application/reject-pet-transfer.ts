// Use-case: reject an owner→owner pet transfer.
//
// Migrated from app/actions/pet-transfer.ts::rejectPetTransferAction.
// Auth (requireUserOrRedirect) is handled by the caller.
// callerEmail is resolved from the Supabase session by the thin action.
//
// Orchestrates:
//   1. Load transfer + status check + recipient auth (id-or-email)
//   2. ATOMIC tx: updateTransferStatus(rejected) + collect sender notification
//   3. Return UseCaseResult<void> + notifications
//
// NO ownership transition on reject.

import { validateRecipientMatch } from "../domain/owner-transfer-rules";
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

export type RejectPetTransferInput = {
  transferToken: string;
  reason?: string | null;
  /** Caller's authenticated email — resolved by the action via Supabase session. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for this account (A09-1).
   *
   * THE GENERIC REFUSAL, not the "confirmá tu correo" sentence the accept path
   * returns, and the asymmetry is deliberate: a reject is reachable only from a
   * screen the viewer read first, and that read (`getTransferForViewer`) already
   * says what to do. Repeating it here would only ever answer a hand-made
   * request.
   */
  callerEmailConfirmed: boolean;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function rejectPetTransfer(
  input: RejectPetTransferInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load transfer.
  const transfer = await repo.findTransferByToken(input.transferToken);
  if (!transfer) return { ok: false, error: "Transferencia no encontrada." };
  if (transfer.status !== "pending") {
    return { ok: false, error: `La transferencia ya está ${transfer.status}.` };
  }

  // 2. Recipient auth (id-or-email).
  const isRecipient = validateRecipientMatch({
    toOwnerId: transfer.toOwnerId,
    toOwnerEmail: transfer.toOwnerEmail,
    callerId: user.id,
    callerEmail: input.callerEmail,
    callerEmailConfirmed: input.callerEmailConfirmed,
  });
  if (!isRecipient) {
    return { ok: false, error: "Esta propuesta no es para tu cuenta." };
  }

  const pendingNotifications: NewNotification[] = [];

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const now = new Date();
      // Conditional flip: only reject while still pending. Serializes against a
      // concurrent accept — the loser sees zero rows and aborts rather than
      // marking an already-accepted transfer as rejected.
      const updatedRows = await repo.updateTransferStatus(
        {
          id: transfer.id,
          status: "rejected",
          respondedAt: now,
          // Parity: set toOwnerId to user.id if it was null (open invite).
          toOwnerId: transfer.toOwnerId ?? user.id,
          rejectionReason: input.reason ?? null,
          expectedStatus: "pending",
        },
        tx as Parameters<typeof repo.updateTransferStatus>[1],
      );
      if (updatedRows === 0) {
        throw new Error("La transferencia ya no está pendiente.");
      }

      pendingNotifications.push({
        userId: transfer.fromOwnerId,
        notificationType: "pet_transfer_rejected",
        severity: "warning",
        title: "Transferencia rechazada",
        body: input.reason
          ? `El receptor rechazó la propuesta. Motivo: ${input.reason}`
          : "El receptor rechazó la propuesta.",
        ctaUrl: "/mis-mascotas",
        ctaLabel: "Ver mis mascotas",
        relatedPetId: transfer.petId,
        category: "custody",
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Error desconocido." };
  }

  return { ok: true, value: { petId: transfer.petId }, notifications: pendingNotifications };
}
