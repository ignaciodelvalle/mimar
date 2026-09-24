-- Migration 0062: backfill note_added sighting events.
--
-- For every pet_events row where:
--   event_type = 'note_added'
--   payload->>'text' starts with '[Avistaje]'
--
-- We:
--   1. Strip the '[Avistaje] ' prefix (with optional trailing space) from text.
--   2. Set payload->>'kind' = 'sighting'.
--
-- Uses jsonb_set + regexp_replace. The outer || merges kind into the existing
-- payload object so all other fields (category, payload_version) are preserved.
-- The regex uses ' ?' (optional space) to handle both '[Avistaje] ' and
-- '[Avistaje]' (no trailing space) edge cases.
--
-- The WHERE clause includes an idempotency guard so re-running this migration
-- is safe: rows already tagged with kind='sighting' are skipped.
--
-- Author only — do NOT run against production without review.

UPDATE pet_events
SET payload = payload
  -- Strip the '[Avistaje] ' prefix from text (space is optional).
  || jsonb_build_object(
       'text',
       regexp_replace(payload->>'text', '^\[Avistaje\] ?', '', '')
     )
  -- Inject the sighting discriminator.
  || jsonb_build_object('kind', 'sighting')
WHERE event_type = 'note_added'
  AND payload->>'text' LIKE '[Avistaje]%'
  AND (payload->>'kind') IS DISTINCT FROM 'sighting';
