-- ────────────────────────────────────────────────────────────────────────────
-- 0247_outbox_eno_case_key.sql
-- One ENO record per case: event_notification_outbox learns which CASE a row
-- notifies, and the database refuses a second row for the same case.
--
-- WHY (PO, 2026-09-25)
-- --------------------
-- "A Case may not be duplicated; all information related to a single event
-- must be concentrated in a single record for consistency."
--
-- A rabies DIAGNOSIS wrote a Cola ENO row (clinical_info_logged rule) plus a
-- second one for the outbreak_signal it derives (triggered_by
-- direct_diagnosis), and a POSITIVE CLOSE of the same animal's observation
-- (rule added by 01952b5d7) wrote a third. Three legal notifications, three
-- SLAs, one rabid animal. The outbox had no key of its own: idempotency was
-- per SOURCE EVENT, and these are three different events.
--
-- WHAT
-- ----
--   eno_case_key   text, NULL for every rule that cannot name a case (all rules
--                  but rabies today). Rabies is keyed per ANIMAL
--                  ('rabies:pet:<pet uuid>'): the disease is fatal, so one
--                  animal carries at most one rabies case. The key is computed
--                  in lib/events/event-outbox-rules.ts, never here.
--   linked_sources jsonb array. The second writer of a case APPENDS its source
--                  event (id, type, time, snapshot, and the row's status before
--                  the link) instead of inserting a row. This is the audit trail
--                  of the merge.
--   outbox_eno_case_unique  UNIQUE (target_kind, eno_case_key) WHERE the key
--                  is not null — the enqueue's ON CONFLICT target, so two
--                  writers racing for one case cannot both insert.
--
-- The outbox is a delivery QUEUE (status, attempts, next_retry_at are updated
-- by the drainer), not the event spine, so linking into an existing row is an
-- update of operational state; pet_events stay append-only and untouched.
--
-- LEGACY ROWS
-- -----------
-- Existing rows keep eno_case_key NULL, so this migration cannot fail on
-- today's duplicates. scripts/backfill-eno-case-merge.ts (dry-run by default)
-- lists duplicate groups and positive closures with no ENO row, and with
-- --apply keys, merges and creates per the same rule.
--
-- Additive, idempotent (IF NOT EXISTS).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE event_notification_outbox
  ADD COLUMN IF NOT EXISTS eno_case_key text;

ALTER TABLE event_notification_outbox
  ADD COLUMN IF NOT EXISTS linked_sources jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_eno_case_unique
  ON event_notification_outbox (target_kind, eno_case_key)
  WHERE eno_case_key IS NOT NULL;
