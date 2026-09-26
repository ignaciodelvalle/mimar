// The receiving authority marks an ENO outbox row "recibido" (PO S3,
// 2026-09-26). While no real receiver exists, this is the ONLY way a row
// leaves 'pending': the drainer records its no-op pass and leaves the row
// alone (lib/infra/outbox-drainer.ts), so an unacknowledged notice past its
// deadline stays visibly overdue.
//
// One transaction: the row is read FOR UPDATE through the SAME scope clause
// the /gob/outbox list uses (lib/infra/outbox-query.ts — a govt sees and acts
// on its own jurisdiction only, fail-closed on an empty mandate), moved to
// 'received' with who and when, and the act enters audit_log.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, eventNotificationOutbox } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { buildOutboxWhere } from "@/lib/infra/outbox-query";

export type OutboxReceiptResult =
  | { ok: true; receivedAt: Date; overdue: boolean }
  | { ok: false; reason: "not_found" | "merged" | "already_received" };

export class OutboxReceiptRepository {
  /**
   * @param scope — undefined = national (every row); an array = a govt
   *                mandate (an EMPTY array matches nothing).
   */
  async markReceived(input: {
    rowId: string;
    actorUserId: string;
    actorRole: string;
    scope: ReadonlyArray<{ province: string; locality: string }> | undefined;
  }): Promise<OutboxReceiptResult> {
    return db.transaction(async (tx) => {
      const inScope = buildOutboxWhere({}, { jurisdiction: input.scope, cursor: null });
      const [row] = await tx
        .select({
          id: eventNotificationOutbox.id,
          status: eventNotificationOutbox.status,
          targetKind: eventNotificationOutbox.targetKind,
          sourceEventId: eventNotificationOutbox.sourceEventId,
          slaDueAt: eventNotificationOutbox.slaDueAt,
          province: eventNotificationOutbox.targetJurisdictionProvince,
          locality: eventNotificationOutbox.targetJurisdictionLocality,
          overdue: sql<boolean>`${eventNotificationOutbox.slaDueAt} < now()`,
        })
        .from(eventNotificationOutbox)
        .where(and(eq(eventNotificationOutbox.id, input.rowId), inScope))
        .limit(1)
        .for("update");
      // Out of scope reads exactly like absent: no existence oracle.
      if (!row) return { ok: false, reason: "not_found" };
      if (row.status === "merged") return { ok: false, reason: "merged" };
      if (row.status === "received" || row.status === "delivered") {
        return { ok: false, reason: "already_received" };
      }

      const [updated] = await tx
        .update(eventNotificationOutbox)
        .set({
          status: "received",
          receivedAt: sql`now()`,
          receivedByUserId: input.actorUserId,
        })
        .where(eq(eventNotificationOutbox.id, row.id))
        .returning({ receivedAt: eventNotificationOutbox.receivedAt });
      const receivedAt = updated?.receivedAt ?? new Date();

      await writeAuditLog(tx, {
        action: "eno_notification_received",
        actorUserId: input.actorUserId,
        payload: {
          outbox_row_id: row.id,
          target_kind: row.targetKind,
          source_event_id: row.sourceEventId,
          sla_due_at: row.slaDueAt.toISOString(),
          received_at: receivedAt.toISOString(),
          overdue: row.overdue === true,
          actor_role: input.actorRole,
          target_jurisdiction_province: row.province,
          target_jurisdiction_locality: row.locality,
        },
        before: { status: row.status },
        after: { status: "received" },
      });

      return { ok: true, receivedAt, overdue: row.overdue === true };
    });
  }
}
