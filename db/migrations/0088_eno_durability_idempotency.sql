-- 0088_eno_durability_idempotency.sql
-- ENO pipeline durability + idempotency hardening (V1-4, P1 legal-notification
-- correctness).
--
-- Findings addressed:
--   P1-4 (non-idempotent consumer): process-eno-queue-batch fans out
--     notifications with a plain INSERT and no dedup. Any throw after the
--     insert but before markEnoProcessed leaves the row pending, and the next
--     drain re-inserts the same govt + owner notifications. There was no
--     unique constraint on the notification natural key, so re-runs duplicated
--     legal notifications.
--
-- Fix: a PARTIAL UNIQUE INDEX on the notification natural key
--   (user_id, related_event_id, notification_type) WHERE related_event_id IS NOT NULL.
-- The consumer now inserts with ON CONFLICT DO NOTHING so re-processing the
-- same queue row (or two overlapping cron runs) is a no-op.
--
-- WHY THE PARTIAL PREDICATE:
--   - related_event_id IS NULL for free-standing / cron-emitted notifications
--     (vaccine-due, post-adoption check-ins, etc.). Those legitimately repeat
--     the same (user, type) for different occurrences and must NOT be deduped
--     by this index — they have no event identity to key on. The partial
--     predicate scopes the guard to event-derived notifications only.
--   - The key includes related_event_id so the SAME notification_type to the
--     SAME user for DIFFERENT events is still allowed (that is correct: a vet
--     diagnosing two diseases on the same pet produces two distinct events).
--
-- No P1-3 / P1-5 schema change is required: durability (P1-3) is solved by
-- moving the eno_processing_queue enqueue into the diagnosis transaction (code
-- only — the unique index on pet_event_id already exists, migration 0053), and
-- claim-locking (P1-5) uses FOR UPDATE SKIP LOCKED at query time (no DDL).

-- Pre-flight: this index would fail to create if duplicates already exist.
-- The DO block below checks for pre-existing duplicates and raises a clear
-- descriptive error so a future environment fails loudly instead of with an
-- opaque index-creation error. Dedupe the offending rows before re-applying.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT user_id, related_event_id, notification_type
    FROM notifications
    WHERE related_event_id IS NOT NULL
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0088 pre-flight failed: % duplicate (user_id, related_event_id, notification_type) '
      'tuple(s) found in notifications WHERE related_event_id IS NOT NULL. '
      'Deduplicate these rows before applying this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_natural_key_unique
  ON notifications (user_id, related_event_id, notification_type)
  WHERE related_event_id IS NOT NULL;

COMMENT ON INDEX notifications_event_natural_key_unique IS
  'Idempotency guard for event-derived notifications (ENO fanout et al.). Lets consumers INSERT ... ON CONFLICT DO NOTHING so re-processing a queue row never duplicates a legal notification. Partial: only rows with related_event_id (free-standing/cron notifications are exempt).';
