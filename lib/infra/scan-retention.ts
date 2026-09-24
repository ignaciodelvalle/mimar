// Scan-event retention purge — Wave 5 Item 28.
//
// Deletes credential_scanned events authored by the 'scanner' role that are
// older than SCAN_RETENTION_DAYS (90 days, owner-approved TTL).
//
// PRIVACY MODEL (AGENTS.md §Scan privacy, updated by Task #45):
//   credential_scanned events with author_role='scanner' are created whenever
//   the public credential page /p/[publicToken] is viewed by a non-owner visitor.
//   The payload contains ONLY:
//     - is_self_scan: boolean (false for scanner-role events)
//     - viewer_authenticated: boolean
//     - scan_ip_area: coarse city-precision area from platform geo headers
//       (or null) — NEVER the raw IP (lib/infra/scan-geo.ts)
//     - scan_coords / scan_accuracy_m: precise GPS, ONLY when the pet was lost
//       AND the scanner explicitly granted browser geolocation
//   Scanner-role rows carry recorded_by_user_id = NULL (no identity link) —
//   see src/modules/pets/application/scans/log-scan.ts.
//   After TTL_DAYS the event is purged, which is what bounds retention of ALL
//   location fields: they exist only on scanner-role rows deleted here.
//   Self-scans (author_role='owner', never purged) carry no location fields.
//
// APPEND-ONLY CONTRACT:
//   pet_events is governed by the enforce_pet_events_append_only() trigger.
//   Migration 0104 added a narrow exception: DELETE is allowed when:
//     - author_role = 'scanner' AND event_type = 'credential_scanned'
//     - occurred_at is older than the retention window
//     - the session GUC app.allow_scan_purge = 'true' is set
//   The cron runs as service-role and sets that GUC in a transaction.  Every
//   deleted row produces an audit_log entry (action = 'scan_event_purged').
//
// Batching: PURGE_BATCH_SIZE = 500 matches the pattern in lib/data-lifecycle.ts
// to bound lock duration within Vercel's 10-second function budget.

import { sql } from "drizzle-orm";

import { db } from "@/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for credential_scanned / scanner-role events (owner-approved, Item 28). */
export const SCAN_RETENTION_DAYS = 90;

// ATTRIBUTION (migration 0235, finding A08-6): every `scan_event_purged` audit
// row names the system profile `system:cron-scan-retention` (is_system, no
// auth.users row) — it used to be null, the one audited mutation with no
// actor. The trigger holds the uuid, not this module: nothing here writes the
// audit row, and a uuid literal in lib/ would trip lint:uuid for a value the
// migration, not the environment, pins. __tests__/scan-retention.test.ts
// asserts it.

/** Maximum rows deleted per DELETE batch. Matches lib/data-lifecycle.ts. */
const PURGE_BATCH_SIZE = 500;

/** Wall-clock budget for the drain loop (ms). Keeps the run inside Vercel's
 *  60 s function budget while still draining a large backlog in one pass. */
const PURGE_MAX_DURATION_MS = 45_000;

// ---------------------------------------------------------------------------
// Purge helper
// ---------------------------------------------------------------------------

/**
 * Deletes a single bounded batch of credential_scanned events authored by the
 * 'scanner' role that are older than SCAN_RETENTION_DAYS.
 *
 * Runs inside a transaction with app.allow_scan_purge = 'true' so the
 * append-only trigger (migration 0104 exception path) permits the DELETE.
 *
 * Returns the count of deleted rows (≤ PURGE_BATCH_SIZE).
 */
async function purgeOneScanBatch(cutoff: string): Promise<number> {
  // The append-only trigger refuses DELETE unless app.allow_scan_purge = 'true'
  // is set within the same transaction.  set_config(key, value, is_local=true)
  // scopes the GUC to the transaction duration — it resets automatically on
  // commit or rollback.
  //
  // Note: SET LOCAL is not available via drizzle sql tagged literals because
  // postgres.js sends tagged literals as prepared statements, which cannot
  // contain SET LOCAL.  select set_config(key, value, true) is the idiomatic
  // workaround (same pattern used in scripts/seed-perf.ts).
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.allow_scan_purge', 'true', true)`);

    // Batched subquery DELETE: postgres.js does not support DELETE ... LIMIT
    // natively, so we use a subquery with LIMIT (same pattern as
    // lib/data-lifecycle.ts → purgeOldCronRuns).
    const deleted = (await tx.execute(
      sql`
        DELETE FROM pet_events
        WHERE id IN (
          SELECT id FROM pet_events
          WHERE author_role = 'scanner'
            AND event_type = 'credential_scanned'
            AND occurred_at < ${cutoff}::timestamptz
          LIMIT ${PURGE_BATCH_SIZE}
        )
        RETURNING id
      `,
    )) as Array<{ id: string }>;

    return deleted.length;
  });
}

/**
 * Deletes credential_scanned events authored by the 'scanner' role that are
 * older than SCAN_RETENTION_DAYS.
 *
 * Drains the full backlog in one run (review 23 fleet extension): previously a
 * single 500-row batch per day meant a backlog above 500 could never catch up,
 * leaving location fields on scanner rows past their TTL. Each batch is its own
 * transaction (bounded lock duration); the loop stops when a batch deletes fewer
 * than PURGE_BATCH_SIZE (drained) or the wall-clock budget elapses.
 *
 * Returns the total count of deleted rows across all batches.
 */
export async function purgeExpiredScanEvents(opts?: {
  now?: Date;
  maxDurationMs?: number;
}): Promise<number> {
  const now = opts?.now ?? new Date();
  const maxDurationMs = opts?.maxDurationMs ?? PURGE_MAX_DURATION_MS;
  const cutoff = new Date(now.getTime() - SCAN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const start = Date.now();

  let total = 0;
  for (;;) {
    const deleted = await purgeOneScanBatch(cutoff);
    total += deleted;
    if (deleted < PURGE_BATCH_SIZE || Date.now() - start >= maxDurationMs) break;
  }

  return total;
}
