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

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, eventNotificationOutbox } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { buildRetryPayload } from "@/lib/infra/outbox-list";

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

export async function retryOutboxRowAction(
  rowId: string,
): Promise<{ error?: string; scheduledAt?: string }> {
  await requireAdminOrRedirect();

  const [row] = await db
    .select({ id: eventNotificationOutbox.id })
    .from(eventNotificationOutbox)
    .where(eq(eventNotificationOutbox.id, rowId))
    .limit(1);

  if (!row) {
    return { error: "Fila de outbox no encontrada." };
  }

  const payload = buildRetryPayload();
  await db
    .update(eventNotificationOutbox)
    .set(payload)
    .where(eq(eventNotificationOutbox.id, rowId));

  revalidatePath(`/admin/outbox/${rowId}`);
  revalidatePath("/admin/outbox");

  // Return the scheduled next_retry_at (ISO) so the caller can confirm inline
  // exactly when the drainer will pick the row up — the action gave zero
  // feedback before, so an operator clicked again thinking it failed (Cowork A1).
  return { scheduledAt: payload.nextRetryAt.toISOString() };
}
