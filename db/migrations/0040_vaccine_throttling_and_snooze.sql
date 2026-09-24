-- Migration 0040 — vaccine throttling and snooze support (Chunk C C2)
-- Reference: docs/superpowers/plans/2026-05-21-vaccine-due-ux.md §C2
--            docs/design/06-vaccine-due.md §B.1 (throttling), §E (snooze semantics)
--
-- Idempotent — safe to re-run (IF NOT EXISTS on all DDL).

-- Reminders: snooze support (spec §E — cap 3×7d, then 30d cooldown).
-- snoozed_until: when set and > now, the cron excludes this reminder.
-- snooze_count: tracks how many 7-day snoozes have been used (cap = 3).
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_count integer NOT NULL DEFAULT 0;

-- Notifications: category for /notificaciones tab filtering (spec §D).
-- Free text — values: 'health', 'custody', 'adoption', 'welfare', 'admin'.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS category text;

-- Index for the /notificaciones tab query (filter by user + category).
CREATE INDEX IF NOT EXISTS notifications_user_category_idx
  ON notifications (user_id, category)
  WHERE archived_at IS NULL;

-- Index for the per-reminder throttle check in runVaccineDueScan().
-- Query: SELECT MIN/MAX/COUNT FROM notifications
--        WHERE related_reminder_id = $id AND notification_type LIKE 'vaccine_%'
--        AND archived_at IS NULL
CREATE INDEX IF NOT EXISTS notifications_reminder_recent_idx
  ON notifications (related_reminder_id, created_at DESC)
  WHERE related_reminder_id IS NOT NULL;
