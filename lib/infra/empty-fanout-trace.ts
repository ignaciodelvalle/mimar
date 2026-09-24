// The trace an empty authority fan-out leaves behind.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Routing audit (2026-08-17, engram onboarding/ruteo-y-fallback): a fan-out that
// resolves to ZERO recipients is the only failure in this system that leaves NO
// trace at all. The `for (const id of recipients)` loop runs zero times, the
// server action returns `{ ok: true }`, and nothing lands in `notifications`, in
// `cron_runs`, or in `audit_log`. A reportable-disease diagnosis, a bite report
// or a decomiso handoff can therefore reach nobody while every surface reports
// success — which is precisely why it would be the LAST failure anyone found.
//
// One call here turns that into a row.
//
// WHY audit_log AND NOT notification_dead_letter
// ---------------------------------------------------------------------------
// The dead-letter table looks like the natural home for "this notification did
// not happen", but it is a RETRY QUEUE, not a log: the hourly drainer
// (app/api/cron/drain-notification-dead-letter) replays every unresolved row
// through createNotification(), and a synthetic row with no recipient fails
// `toInput()` → counted `invalid` → the whole cron flips to failed and returns
// HTTP 500. A durable trace must not manufacture an hourly false page.
//
// `audit_log` is append-only, has a nullable actor (FK ON DELETE SET NULL,
// migration 0080), is already the accountability spine, and nothing consumes it
// as work. The action is declared in migration 0187.
//
// WHY sendCronAlert is not enough on its own: `CRON_ALERT_WEBHOOK` is unset in
// every environment today, and sendCronAlert is a graceful no-op without it — so
// on its own it is exactly the silence this module deletes. Cron paths may still
// call it IN ADDITION; this row is what survives.
//
// BEST-EFFORT BY CONSTRUCTION. `writeAuditLog` deliberately does not swallow
// errors, and that is right for a row that describes a mutation. This row
// describes a NON-event that accompanies an already-degenerate outcome, so a
// failure to write it must never turn "nobody was notified" into "the operation
// failed". It is therefore caught and logged here, and nowhere else.

import { db } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";

export type EmptyFanoutTrace = {
  /** Which fan-out went nowhere. Stable, greppable, e.g. "bite_reported_authority". */
  route: string;
  /** Target jurisdiction, when the fan-out had one. `""` means "not specified". */
  province?: string | null;
  locality?: string | null;
  /**
   * Why the set came back empty. "no_govt_no_admin" is the resolver's own case;
   * sites that assemble their own recipient set pass their own reason
   * ("no_receiver_coordinators", "no_org_members", …).
   */
  reason: string;
  /** Anything that identifies the thing that went unannounced (ids, codes). */
  details?: Record<string, unknown>;
};

/**
 * Record that a notification fan-out reached nobody.
 *
 * Never throws and never rejects — see the header. Callers do NOT need a
 * try/catch around it and must not treat its result as a gate.
 */
export async function recordEmptyFanout(trace: EmptyFanoutTrace): Promise<void> {
  try {
    await writeAuditLog(db, {
      action: "notification_fanout_empty",
      // No human acted: the whole point of the row is that the system produced
      // no recipient. The FK is nullable exactly for system writers like this.
      actorUserId: null,
      payload: {
        route: trace.route,
        province: trace.province ?? "",
        locality: trace.locality ?? "",
        reason: trace.reason,
        ...(trace.details ?? {}),
      },
    });
  } catch (err) {
    console.error(
      `[empty-fanout] could not record the empty fan-out for route=${trace.route} (${trace.reason}):`,
      err,
    );
  }
}
