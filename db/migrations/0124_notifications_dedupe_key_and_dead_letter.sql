-- 0124_notifications_dedupe_key_and_dead_letter.sql
-- Notifications reinforcement (consistency review 2026-07-04): give the whole
-- owner-facing notification pipeline ONE write path with ONE dedup guard and a
-- recoverable failure surface.
--
-- Two problems this migration's DDL underwrites (the code side lives in
-- lib/infra/notification-service.ts):
--
--   1. DUPLICATION — migration 0088 added a partial unique index on
--      (user_id, related_event_id, notification_type) WHERE related_event_id IS
--      NOT NULL. By construction that guard EXCLUDES cron-emitted (vaccine_due,
--      post_adoption_checkin) and lost-pet broadcast notifications, which set
--      related_event_id = NULL. Those are exactly the sites the review found
--      duplicating (lost-pet broadcast retry re-notifies every org member;
--      vaccine throttle is check-then-act with no DB guard). We generalize the
--      idempotency guard to a caller-supplied `dedupe_key` that applies to ALL
--      notification types, cron and broadcast included.
--
--   2. DROPOUT — the ARCH-P pattern flushes notifications post-tx wrapped in
--      try/catch that only console.error's on failure. A transient DB blip at
--      flush time means the notification is gone forever while the underlying
--      action succeeded ("a veces no aparecen"). We add a dead-letter table so
--      the service can persist the failed payload instead of only logging —
--      turning "silently gone" into "delayed but recoverable".

-- ---------------------------------------------------------------------------
-- 1. dedupe_key column + generalized partial unique index
-- ---------------------------------------------------------------------------

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

COMMENT ON COLUMN notifications.dedupe_key IS
  'Caller-supplied idempotency key, set by createNotification() (lib/infra/notification-service.ts). Generalizes migration 0088''s event-natural-key guard to cover cron + broadcast notifications, which have no related_event_id. Partial unique index below enforces one row per key. NULL for legacy / not-yet-migrated direct inserts (exempt from the guard).';

-- Pre-flight: the partial unique index would fail to create if two non-null
-- dedupe_key rows already collide. Existing rows all have dedupe_key = NULL
-- (the column is brand new), so this is a no-op guard today, but it fails
-- loudly for any future re-application against a partially-migrated DB.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT dedupe_key
    FROM notifications
    WHERE dedupe_key IS NOT NULL
    GROUP BY dedupe_key
    HAVING count(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0124 pre-flight failed: % duplicate dedupe_key value(s) found in notifications. '
      'Deduplicate these rows before applying this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_unique
  ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON INDEX notifications_dedupe_key_unique IS
  'Idempotency guard for the createNotification() service. Applies to ALL notification types (cron + broadcast included), unlike 0088''s event-only guard. The service inserts with ON CONFLICT (dedupe_key) DO NOTHING so a retry / concurrent double-run is a no-op. Partial: rows with dedupe_key IS NULL (legacy direct inserts) are exempt.';

-- ---------------------------------------------------------------------------
-- 2. Dead-letter surface for failed notification flushes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The dedupe_key the failed insert would have used (nullable — a payload
  -- without a key can still be dead-lettered). NOT unique here: a dead-letter
  -- row is a failure record, not a live notification, and the same key may fail
  -- more than once before it is resolved.
  dedupe_key text,
  -- The full notification insert payload as JSON, so a retry cron can replay it
  -- verbatim through createNotification() once the transient fault clears.
  payload jsonb NOT NULL,
  -- Best-effort capture of the error that caused the flush to fail.
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the retry cron when it re-attempts this payload.
  retried_at timestamptz,
  -- Set when the payload was successfully re-delivered (or manually resolved).
  resolved_at timestamptz
);

COMMENT ON TABLE notification_dead_letter IS
  'Recoverable failure surface for the createNotification() service. When the notifications insert throws (pool exhaustion, deploy-time connection drop, brief outage) the service writes the payload here instead of only console.error''ing — closing the ARCH-P silent-dropout gap (consistency review 2026-07-04 C.1). A follow-on retry cron drains unresolved rows.';

-- Index the "unresolved" working set the retry cron scans.
CREATE INDEX IF NOT EXISTS notification_dead_letter_unresolved_idx
  ON notification_dead_letter (created_at)
  WHERE resolved_at IS NULL;
