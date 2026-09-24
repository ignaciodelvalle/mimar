// Use-case: initiate an owner→owner pet transfer.
//
// Migrated from app/actions/pet-transfer.ts::initiatePetTransferAction.
// Auth (requireUserOrRedirect + active owner check) is handled by the caller.
// findUserIdByEmail via admin SDK stays a repo method (infra concern).
// inviteUserByEmail is best-effort and stays in the thin action (needs Next.js edge).
//
// Orchestrates:
//   1. Email + reason validation (domain rules)
//   2. Pet lookup + status guard (deceased / lost / dispute)
//   3. Active owner check — caller must be the current owner
//   4. Recipient lookup by email (admin SDK via repo) + self-transfer guard
//   5. Atomic tx: insertPetTransfer
//   6. Collect notifications: sender confirmation + recipient (if known account)
//   7. Return UseCaseResult<{ transferToken, petId, recipientNeedsInvite }>
//
// NOT handled here (stays in action):
//   - requireUserOrRedirect
//   - callerEmail resolution (Supabase session)
//   - inviteUserByEmail (best-effort, non-fatal)
//   - auditLog insert (action concerns)
//   - revalidatePath

import { matchesDbError } from "@/lib/infra/db-errors";
import { generatePrefixedToken } from "@/lib/infra/publicToken";
import {
  computeTransferExpiresAt,
  isValidTransferEmail,
  validateOwnerTransferReason,
  validatePetNotSponsored,
  validatePetStatusForTransfer,
  validateSelfTransfer,
} from "../domain/owner-transfer-rules";
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

export type InitiatePetTransferInput = {
  petToken: string;
  toEmail: string;
  reason: string;
  note?: string | null;
  /** Caller's authenticated email — resolved by the action via Supabase session. */
  callerEmail: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function initiatePetTransfer(
  input: InitiatePetTransferInput,
  deps: Deps,
): Promise<
  UseCaseResult<{
    transferToken: string;
    petId: string;
    /** True when recipient has no account — action should call inviteUserByEmail */
    recipientNeedsInvite: boolean;
    petName: string;
  }>
> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Email validation.
  const toEmail = input.toEmail.trim().toLowerCase();
  if (!isValidTransferEmail(toEmail)) {
    return { ok: false, error: "Email inválido." };
  }

  // 2. Reason validation.
  const reasonResult = validateOwnerTransferReason(input.reason);
  if (!reasonResult.ok) return reasonResult;
  const reason = reasonResult.value;

  // 3. Pet lookup.
  const pet = await repo.findPetByToken(input.petToken);
  if (!pet) return { ok: false, error: "No encontramos la mascota." };

  // 4. Pet status guard.
  const statusGuard = validatePetStatusForTransfer({
    status: pet.status,
    inCustodyDispute: pet.inCustodyDispute,
  });
  if (!statusGuard.ok) return statusGuard;

  // 5. Active owner check.
  const ownership = await repo.findActiveOwnerOwnership(pet.id);
  if (!ownership || ownership.ownerUserId !== user.id) {
    return { ok: false, error: "Solo el dueño actual puede iniciar una transferencia." };
  }

  // 5b. Sponsored-pet guard (rehome-by-titular, REQ-15). Readable refusal
  // here, before a recipient is bothered and before an invitation email goes
  // out; the accept re-checks under the transfer lock, because a sponsorship
  // can start during the 7-day window. Same two-layer shape the cross-org twin
  // uses (propose pre-read + accept under the lock).
  const notSponsored = validatePetNotSponsored({
    openSponsorship: await repo.findOpenSponsorship(pet.id),
  });
  if (!notSponsored.ok) return notSponsored;

  // 6. Recipient lookup + self-transfer guard.
  const toOwnerId = await repo.findUserIdByEmail(toEmail);
  if (toOwnerId !== null) {
    const selfGuard = validateSelfTransfer(user.id, toOwnerId);
    if (!selfGuard.ok) return selfGuard;
  }
  const recipientNeedsInvite = toOwnerId === null;

  const now = new Date();
  const expiresAt = computeTransferExpiresAt(now);
  const publicToken = generatePrefixedToken("PTR");

  const pendingNotifications: NewNotification[] = [];

  // 7. Atomic transaction.
  try {
    await transaction(async (tx) => {
      await repo.insertPetTransfer(
        {
          publicToken,
          petId: pet.id,
          fromOwnerId: user.id,
          toOwnerId,
          toOwnerEmail: toEmail,
          status: "pending",
          reason,
          note: input.note ?? null,
          expiresAt,
        },
        tx as Parameters<typeof repo.insertPetTransfer>[1],
      );
    });
  } catch (err) {
    // drizzle 0.45 wraps pg errors; matchesDbError walks the `.cause` chain to
    // the real constraint name (no longer on the top-level message).
    if (matchesDbError(err, { constraint: /pet_transfers_one_pending_per_pet/ })) {
      return { ok: false, error: "Ya hay una transferencia pendiente para esta mascota." };
    }
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return { ok: false, error: `No se pudo crear la transferencia: ${message}` };
  }

  // 8. Collect notifications.
  if (toOwnerId) {
    pendingNotifications.push({
      userId: toOwnerId,
      notificationType: "pet_transfer_received",
      severity: "warning",
      title: `Te ofrecen la titularidad de ${pet.name}`,
      body: "Recibiste una propuesta de transferencia. Tenés 7 días para aceptar o rechazar.",
      ctaLabel: "Ver propuesta",
      ctaUrl: `/transferencias/${publicToken}`,
      relatedPetId: pet.id,
      category: "custody",
    });
  }

  pendingNotifications.push({
    userId: user.id,
    notificationType: "pet_transfer_initiated",
    severity: "info",
    title: "Transferencia enviada",
    body: `Avisamos a ${toEmail}. Si no responde en 7 días la propuesta expira.`,
    ctaLabel: "Ver propuesta",
    ctaUrl: `/transferencias/${publicToken}`,
    relatedPetId: pet.id,
    category: "custody",
  });

  return {
    ok: true,
    value: { transferToken: publicToken, petId: pet.id, recipientNeedsInvite, petName: pet.name },
    notifications: pendingNotifications,
  };
}
