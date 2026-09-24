// createNotification() — the single write path for the owner-facing
// notification pipeline.
//
// WHY THIS EXISTS (consistency review 2026-07-04, dim-interno:docs/design/handoffs/
// 2026-07-04-notifications-consistency-review.md):
//   The `notifications` table is a single canonical STORAGE location, but there
//   was no single WRITE path — 84 call sites each reinvented their own dedup
//   posture and failure handling. That is the structural reason two bug classes
//   kept recurring at different sites:
//     - DUPLICATION: migration 0088's unique index only covers
//       related_event_id IS NOT NULL, so cron + broadcast notifications had no
//       DB-level dedup guard (lost-pet broadcast re-notified on retry; the
//       vaccine throttle was check-then-act with a race window).
//     - DROPOUT: the ARCH-P post-tx flush swallows insert failures with a bare
//       console.error, so a transient DB blip means the notification is gone
//       forever while the underlying action succeeded ("a veces no aparecen").
//
// This service closes both with one contract:
//   1. Every caller MUST supply a `dedupeKey`. The insert runs with
//      ON CONFLICT (dedupe_key) DO NOTHING against the migration-0124 partial
//      unique index, so a retry / concurrent double-run is a no-op for ANY
//      notification type (cron + broadcast included).
//   2. On insert failure the payload is DEAD-LETTERED (notification_dead_letter)
//      instead of silently dropped, turning "gone forever" into "delayed but
//      recoverable".
//
// This is NOT a full outbox rewrite. The 84 direct db.insert(notifications)
// call sites migrate onto this path incrementally; scripts/check-notifications-
// service.ts bans NEW direct inserts so the pattern stops recurring.

import "server-only";

import { db as defaultDb, notificationDeadLetter, notifications } from "@/db";
import { summarizeDeadLetterError } from "@/lib/infra/dead-letter-error-summary";
import { sendPushForNotifications } from "@/lib/infra/web-push";
import { sql } from "drizzle-orm";

type DB = typeof defaultDb;

/**
 * The transaction/db client accepted by the service. Loose on purpose so
 * callers can pass either the shared `db` pool or a transaction handle.
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts db | tx; both expose the insert builder we use.
type DbOrTx = DB | any;

/**
 * The full `notification_severity` pg enum, as a checked-in array (not just a
 * union) so a validator can check membership at runtime instead of hand-writing
 * a `===` chain that silently drifts from this list (A06-G4, 2026-09): the
 * dead-letter drain's replay validator (notification-dead-letter-replay.ts)
 * tested only `warning`/`urgent`/`info` after `"success"` joined this type on
 * 2026-08-19, so a replayed success notification fell through to
 * `input.severity ?? "info"` and silently downgraded. Adding a FIFTH severity
 * here is now the one edit that keeps both sides honest — the drain imports
 * this same array rather than repeating the list.
 */
export const NOTIFICATION_SEVERITIES = ["info", "success", "warning", "urgent"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export type CreateNotificationInput = {
  userId: string;
  notificationType: string;
  title: string;
  body?: string | null;
  /**
   * The full `notification_severity` pg enum. `"success"` was missing from this
   * union until 2026-08-19 — a type narrower than the column it writes to, so a
   * caller with a legitimately celebratory notice (caretaker invitation
   * accepted) could not migrate onto this service without downgrading its copy
   * to `"info"`. Widening an input union accepts strictly more; the Web Push leg
   * already typed `"success"`.
   */
  severity?: NotificationSeverity;
  category?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedEventId?: string | null;
  relatedReminderId?: string | null;
  relatedCaseId?: string | null;
  /**
   * REQUIRED idempotency key. Two inserts with the same key collapse to one
   * row (ON CONFLICT DO NOTHING against notifications_dedupe_key_unique). Pick
   * a key that is STABLE across retries of the same logical notification but
   * DISTINCT across ones that should legitimately co-exist. Examples:
   *   - lost-pet broadcast:  `lost:${caseId}:${recipientUserId}`
   *   - vaccine cron tick:   `vaccine:${reminderId}:${YYYY-MM-DD}`
   *   - event-derived:       `event:${eventId}:${userId}:${type}`
   */
  dedupeKey: string;
  /**
   * Suppress the Web Push leg for this row while still writing the in-app
   * notification (and its badge count). NOT persisted — it only gates delivery.
   *
   * The motivating case (native-readiness RN-3 F5): the vaccine scan runs in the
   * 04:00 UTC daily dispatcher = 01:00 ART, and `overdue_critical` re-emits
   * every day at `urgent`, so an owner got a push at 1 AM daily. The FIRST
   * transition to overdue still pushes (the reminder is news); the daily
   * re-emits set this flag so they stay in-app only. A precursor to the
   * per-type push registry (RN-3 B16).
   */
  suppressPush?: boolean;
};

export type CreateNotificationResult =
  | { status: "inserted"; id: string }
  | { status: "duplicate"; id: null }
  | { status: "dead_lettered"; id: null };

/**
 * Insert one notification through the canonical write path.
 *
 * - Idempotent: a repeat call with the same `dedupeKey` returns
 *   `{ status: "duplicate" }` without inserting a second row.
 * - Durable: if the insert throws, the payload is written to
 *   notification_dead_letter and the call returns `{ status: "dead_lettered" }`
 *   — it never re-throws, so a notification failure can never roll back or
 *   block the caller's primary intent (the ARCH-P contract).
 *
 * Pass a transaction handle as `client` only when you deliberately want the
 * notification to share the caller's transaction; the default (shared `db`
 * pool) keeps the insert OUT of the business transaction, per ARCH-P.
 */
export async function createNotification(
  input: CreateNotificationInput,
  client: DbOrTx = defaultDb,
): Promise<CreateNotificationResult> {
  const values = {
    userId: input.userId,
    notificationType: input.notificationType,
    title: input.title,
    body: input.body ?? null,
    severity: input.severity ?? "info",
    category: input.category ?? null,
    ctaLabel: input.ctaLabel ?? null,
    ctaUrl: input.ctaUrl ?? null,
    relatedPetId: input.relatedPetId ?? null,
    relatedEventId: input.relatedEventId ?? null,
    relatedReminderId: input.relatedReminderId ?? null,
    relatedCaseId: input.relatedCaseId ?? null,
    dedupeKey: input.dedupeKey,
  };

  try {
    const inserted = await (client as DB)
      .insert(notifications)
      .values(values)
      .onConflictDoNothing({
        // Conflict target + predicate must match the partial unique index
        // notifications_dedupe_key_unique (WHERE dedupe_key IS NOT NULL).
        target: notifications.dedupeKey,
        where: sql`${notifications.dedupeKey} IS NOT NULL`,
      })
      .returning({ id: notifications.id });

    if (inserted.length > 0) {
      // Web Push leg (ADR 2026-07-18 §4): urgent-only, best-effort, never
      // throws. Runs only for genuinely NEW rows — a dedupe no-op must not
      // re-push. Duplicate sends from retries collapse browser-side via the
      // notification tag (= dedupeKey). SKIPPED when the caller passed a
      // transaction handle: push network I/O must never hold a business tx
      // open, and a post-insert rollback would leave a push delivered for a
      // row that never committed. Tx callers get push when their outer flow
      // re-notifies via the pool-backed path.
      if (client === defaultDb && !input.suppressPush) {
        await sendPushForNotifications([values]);
      }
      return { status: "inserted", id: inserted[0].id };
    }
    // No row returned → the dedupe_key already existed. Idempotent no-op.
    return { status: "duplicate", id: null };
  } catch (err) {
    // DROPOUT FIX (review C.1): a transient DB fault must not silently drop the
    // notification. Persist the payload so a retry cron can replay it. The
    // dead-letter write is itself best-effort — if even that fails we fall back
    // to console.error, which is strictly no worse than the pre-service world.
    await deadLetter(values, err, client);
    return { status: "dead_lettered", id: null };
  }
}

// Chunk size for the bulk path. At national scale a single lost-pet broadcast
// can match thousands of recipients; one giant multi-row INSERT holds a long
// write lock and risks exceeding the bind-parameter limit. Batching keeps each
// statement short and the lock window small (preserves the N+1-avoidance work
// in lost-pet-broadcast.ts).
const BULK_INSERT_CHUNK = 500;

export type CreateNotificationsBulkResult = {
  insertedCount: number;
  duplicateCount: number;
  deadLetteredCount: number;
};

/**
 * Bulk variant of createNotification for high-fan-out sites (lost-pet
 * broadcast). Same two guarantees — ON CONFLICT (dedupe_key) DO NOTHING for
 * idempotency, dead-letter on failure — but inserts in chunks so a
 * thousand-recipient broadcast stays one short statement per 500 rows instead
 * of a thousand round-trips.
 *
 * A chunk that throws is dead-lettered row-by-row and the run CONTINUES to the
 * next chunk, so a mid-fanout DB blip degrades to "some recipients delayed"
 * (recoverable) rather than "all-or-nothing silent loss".
 */
export async function createNotificationsBulk(
  inputs: CreateNotificationInput[],
  client: DbOrTx = defaultDb,
): Promise<CreateNotificationsBulkResult> {
  let insertedCount = 0;
  let duplicateCount = 0;
  let deadLetteredCount = 0;

  for (let i = 0; i < inputs.length; i += BULK_INSERT_CHUNK) {
    const chunk = inputs.slice(i, i + BULK_INSERT_CHUNK);
    const values = chunk.map((input) => ({
      userId: input.userId,
      notificationType: input.notificationType,
      title: input.title,
      body: input.body ?? null,
      severity: input.severity ?? "info",
      category: input.category ?? null,
      ctaLabel: input.ctaLabel ?? null,
      ctaUrl: input.ctaUrl ?? null,
      relatedPetId: input.relatedPetId ?? null,
      relatedEventId: input.relatedEventId ?? null,
      relatedReminderId: input.relatedReminderId ?? null,
      relatedCaseId: input.relatedCaseId ?? null,
      dedupeKey: input.dedupeKey,
    }));

    try {
      const inserted = await (client as DB)
        .insert(notifications)
        .values(values)
        .onConflictDoNothing({
          target: notifications.dedupeKey,
          where: sql`${notifications.dedupeKey} IS NOT NULL`,
        })
        .returning({ id: notifications.id });
      insertedCount += inserted.length;
      duplicateCount += values.length - inserted.length;
      // Web Push leg — urgent-only, best-effort. When a chunk mixes new rows
      // and dedupe no-ops we cannot map returned ids back to inputs, so we
      // push for every urgent input in a chunk that inserted at least one row;
      // the browser-side tag (= dedupeKey) collapses any double-display.
      // Skipped for tx clients — see createNotification's rationale.
      //
      // suppressPush is honored here too (same contract as createNotification):
      // an input that opted out of push must not be pushed just because it rode
      // the bulk path. values[i] and chunk[i] are index-aligned.
      if (inserted.length > 0 && client === defaultDb) {
        const pushable = values.filter((_, idx) => !chunk[idx].suppressPush);
        if (pushable.length > 0) await sendPushForNotifications(pushable);
      }
    } catch (err) {
      for (const v of values) {
        await deadLetter(v, err, client);
        deadLetteredCount += 1;
      }
    }
  }

  return { insertedCount, duplicateCount, deadLetteredCount };
}

async function deadLetter(
  values: typeof notifications.$inferInsert & { dedupeKey: string },
  err: unknown,
  client: DbOrTx,
): Promise<void> {
  // NEVER err.message: a DrizzleQueryError's message carries the query params,
  // i.e. the whole notification (recipient, title, body, CTA) — and on the bulk
  // path every recipient of the chunk. See lib/infra/dead-letter-error-summary.ts
  // and migration 0228, which corrects 0226's claim that this column is harmless.
  const errorMessage = summarizeDeadLetterError(err);
  try {
    // Dead-letter on the SHARED pool, not the caller's client: if `client` is a
    // transaction that just failed/aborted, further statements on it would also
    // fail. The default pool gives the payload the best chance of landing.
    await defaultDb.insert(notificationDeadLetter).values({
      dedupeKey: values.dedupeKey,
      payload: values,
      errorMessage,
    });
  } catch (deadLetterErr) {
    // Never the raw `deadLetterErr`: it can be the SAME DrizzleQueryError shape
    // as `err` above — its message carries the query params, i.e. the whole
    // notification — so it goes through the same summariser before it ever
    // reaches a log line.
    console.error("[createNotification] insert AND dead-letter both failed — notification lost:", {
      dedupeKey: values.dedupeKey,
      insertError: errorMessage,
      deadLetterErr: summarizeDeadLetterError(deadLetterErr),
    });
  }
}
