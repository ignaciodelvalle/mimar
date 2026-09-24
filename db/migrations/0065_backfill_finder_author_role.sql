-- Migration 0065: backfill author_role = 'finder' for finder_in_possession events.
--
-- Targets only note_added events whose payload->>'kind' = 'finder_in_possession'
-- that were previously inserted with author_role = 'scanner' (the fallback used
-- before the 'finder' enum value existed). Sighting events legitimately use
-- 'scanner' and are intentionally excluded.
--
-- Safe to re-run: the WHERE clause's idempotency guard skips already-updated rows.
-- Must run AFTER migration 0064 (which adds the 'finder' value to the enum).

BEGIN;

UPDATE pet_events
SET    author_role = 'finder'
WHERE  event_type  = 'note_added'
  AND  payload->>'kind' = 'finder_in_possession'
  AND  author_role = 'scanner';

COMMIT;
