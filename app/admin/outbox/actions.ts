"use server";

// Admin outbox server actions.
//
// retryOutboxRowAction — resets a pending/failed outbox row so the drainer
// cron picks it up on its next tick (within 5 min). Does NOT deliver
// synchronously: it only unblocks the row by setting next_retry_at = now()
// and status = 'pending'. The drainer cron handles actual delivery.
//
// Note: calling this on an already-pending row is idempotent — it just
// moves next_retry_at to now so the drainer re-prioritises the row.
//
// AUDITED (plan maestro A12, migration 0287). A retry can make an authority
// receive the same notice again, so who asked for it is an operator act:
// `outbox_row_retry_requested`, in the transaction that re-queues the row.
// It was baselined debt in scripts/audit-log-coverage-baseline.json until then.
// The write lives in src/modules/surveillance/infrastructure/
// outbox-retry-repository.ts; this file keeps the guard and the revalidation.

import { revalidatePath } from "next/cache";

import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { OutboxRetryRepository } from "@/src/modules/surveillance/infrastructure/outbox-retry-repository";

const retryRepo = new OutboxRetryRepository();

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

export async function retryOutboxRowAction(
  rowId: string,
): Promise<{ error?: string; scheduledAt?: string }> {
  const { user } = await requireAdminOrRedirect();

  const result = await retryRepo.requeue({ rowId, actorUserId: user.id });
  if (!result.ok) {
    // A merged legacy duplicate (migration 0247) lives on its case record now;
    // re-opening it would send the same notice twice. The page hides the button
    // (canRetry); this refuses the hand-posted call too.
    return {
      error:
        result.reason === "merged"
          ? "Esta fila está unificada en otro registro y no se reenvía."
          : "Fila de outbox no encontrada.",
    };
  }

  revalidatePath(`/admin/outbox/${rowId}`);
  revalidatePath("/admin/outbox");

  // Return the scheduled next_retry_at (ISO) so the caller can confirm inline
  // exactly when the drainer will pick the row up — the action gave zero
  // feedback before, so an operator clicked again thinking it failed (Cowork A1).
  return { scheduledAt: result.scheduledAt.toISOString() };
}
