// An admin re-queues a notification outbox row (/admin/outbox "Reintentar"):
// status back to 'pending' and next_retry_at = now, so the drainer cron picks
// it up on its next tick. It does NOT deliver synchronously.
//
// One transaction: the row is read FOR UPDATE, a merged legacy duplicate
// (migration 0247 — it lives on its case record now) is refused, and the act
// enters audit_log as `outbox_row_retry_requested` with the status before and
// after (plan maestro A12, migration 0287). A retry can make an authority
// receive the same notice again, so who asked for it is an operator act.
//
// Calling it on an already-pending row is idempotent — it just moves
// next_retry_at to now so the drainer re-prioritises the row (and records
// that somebody asked).

import "server-only";

import { eq } from "drizzle-orm";

import { db, eventNotificationOutbox } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { buildRetryPayload } from "@/lib/infra/outbox-list";

export type OutboxRetryResult =
  | { ok: true; scheduledAt: Date }
  | { ok: false; reason: "not_found" | "merged" };

export class OutboxRetryRepository {
  async requeue(input: { rowId: string; actorUserId: string }): Promise<OutboxRetryResult> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: eventNotificationOutbox.id, status: eventNotificationOutbox.status })
        .from(eventNotificationOutbox)
        .where(eq(eventNotificationOutbox.id, input.rowId))
        .limit(1)
        .for("update");
      if (!row) return { ok: false, reason: "not_found" };
      if (row.status === "merged") return { ok: false, reason: "merged" };

      const payload = buildRetryPayload();
      await tx
        .update(eventNotificationOutbox)
        .set(payload)
        .where(eq(eventNotificationOutbox.id, row.id));
      await writeAuditLog(tx, {
        action: "outbox_row_retry_requested",
        actorUserId: input.actorUserId,
        payload: { outbox_row_id: row.id },
        before: { status: row.status },
        after: { status: payload.status, next_retry_at: payload.nextRetryAt.toISOString() },
      });
      return { ok: true, scheduledAt: payload.nextRetryAt };
    });
  }
}
