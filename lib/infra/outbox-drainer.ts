// Outbox drainer helpers — shared between the cron route and tests.
//
// Exports pure-logic helpers so the route stays thin and testable:
//   - BACKOFF_MINUTES: retry schedule per spec C4
//   - MAX_ATTEMPTS: max delivery attempts before marking failed
//   - computeNextRetryAt(attempts, now): next retry timestamp
//   - deliverOutboxRow(row): v1 no-op + audit-log delivery handler
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.4, C.6, C.7

import { type EventNotificationOutbox, auditLog, db } from "@/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Exponential backoff schedule in minutes, per plan §4 C.4.
 * Index = attempts already made (1-based entry: after attempt 1, wait BACKOFF_MINUTES[0]).
 */
export const BACKOFF_MINUTES: readonly number[] = [5, 15, 45, 120, 360, 720, 1440, 1440];

/** Maximum delivery attempts. On the 8th failure, status → 'failed'. */
export const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Backoff computation
// ---------------------------------------------------------------------------

/**
 * Returns the next retry timestamp after `attempts` failed attempts.
 *
 * @param attempts — number of attempts already made (1-indexed: call with 1
 *                   after the FIRST failure to get the first backoff window).
 * @param now      — base timestamp to compute from (defaults to current time).
 */
export function computeNextRetryAt(attempts: number, now: Date = new Date()): Date {
  const idx = Math.min(attempts - 1, BACKOFF_MINUTES.length - 1);
  const waitMs = BACKOFF_MINUTES[idx] * 60_000;
  return new Date(now.getTime() + waitMs);
}

// ---------------------------------------------------------------------------
// Delivery handler (v1 no-op)
// ---------------------------------------------------------------------------

export type DeliverResult = { ok: true } | { ok: false; error: string };

/**
 * Delivers an outbox row to its target.
 *
 * v1: all target_kind handlers are no-ops + audit-log entries per plan §4 C.6/C.7.
 * When a real HTTP receiver exists in a later version, the 'govt_webhook' case
 * gets the actual fetch call; nothing else in this file changes.
 */
export async function deliverOutboxRow(row: EventNotificationOutbox): Promise<DeliverResult> {
  try {
    switch (row.targetKind) {
      case "govt_webhook":
      case "eno_authority":
      case "audit_export":
      case "internal_dashboard": {
        // v1: write an audit-log entry documenting what WOULD have been sent.
        // audit_log.actor_user_id is a nullable SET NULL FK (migration 0080) — a
        // real profile is not strictly required, but we use the system-actor
        // pattern (oldest active institutional admin) so the row carries a
        // meaningful actor when possible. If no admin exists (empty DB / test
        // env), we skip the audit row rather than blocking delivery.
        const { profiles } = await import("@/db");
        const { and, eq, isNull } = await import("drizzle-orm");

        const [systemActor] = await db
          .select({ id: profiles.id })
          .from(profiles)
          .where(
            and(
              eq(profiles.role, "admin"),
              eq(profiles.accountType, "institutional"),
              isNull(profiles.deactivatedAt),
            ),
          )
          .orderBy(profiles.createdAt)
          .limit(1);

        if (systemActor) {
          await db.insert(auditLog).values({
            actorUserId: systemActor.id,
            action: "eno_notification_emitted",
            payload: {
              outbox_row_id: row.id,
              target_kind: row.targetKind,
              source_event_id: row.sourceEventId,
              target_jurisdiction_province: row.targetJurisdictionProvince,
              target_jurisdiction_locality: row.targetJurisdictionLocality,
              sla_due_at: row.slaDueAt?.toISOString(),
              would_send: true,
              v1_noop: true,
              note: `outbox.${row.targetKind}.would_send — real receiver not yet implemented`,
            },
          });
        }

        return { ok: true };
      }

      default: {
        // Unknown target_kind — should never happen with proper enum constraints.
        return { ok: false, error: `unknown target_kind: ${row.targetKind}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown delivery error",
    };
  }
}

// ---------------------------------------------------------------------------
// Outbreak investigation outbox (placeholder — v1 no-op)
// ---------------------------------------------------------------------------
//
// Outbreak investigation notifications (SNVS/SENASA/zoonosis) are NOT
// integrated yet. Actions write v1_noop=true in audit_log payload rows so
// future automation can identify cases that need replay.
//
// Wire actual dispatch logic here when the integration target is confirmed.

export async function drainOutbreakNotificationOutbox(): Promise<{
  processed: number;
  failed: number;
  v1_noop: true;
}> {
  return { processed: 0, failed: 0, v1_noop: true };
}
