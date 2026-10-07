-- ────────────────────────────────────────────────────────────────────────────
-- 0291_event_places_homonym_by_coordinates.sql
-- A method value of its own for "a homonym settled by the event's own
-- coordinates" (plan maestro A2; PO decision 2026-10-07).
--
-- WHY
-- ---
-- The coordinate pass (lib/place/event-places-coordinate-pass.ts) settles an
-- UNRESOLVED event_places row whose (province, locality) name names two or
-- more live catalogue rows, using the point the event itself recorded
-- (pet_events.location_lat / location_lng): nearest candidate centroid within
-- 20 km, the runner-up at least 10 km farther AND twice as far, otherwise it
-- stays unresolved. None of 0250's methods says that:
--   - geocode_unique means a GEOCODED name named ONE row and the pin
--     corroborated it — here the name named several;
--   - spine_rederived / *_name_unique mean the record or the name alone named
--     the row.
-- So the pass gets its own value, `homonym_by_coordinates`, and the reader can
-- always tell a row the point decided from one the name decided.
--
-- WHERE
-- -----
--   - event_places.method: the only column the pass writes.
--   - place_resolutions.method: the pass's audit trail (one append-only row
--     per settled event_places row, subject_table 'event_places'), the same
--     record every later place resolution keeps (0250).
-- NOT the `place_method` columns of pets / cases / welfare_reports (or any
-- other 0248 table): the pass never writes them, and no writer of theirs may
-- claim this method. Their `<table>_place_method_known` CHECKs stay exactly
-- lib/domain/place.ts PLACE_METHODS (__tests__/place-columns.test.ts), and
-- event payloads keep validating against that list too, so 0250's projection
-- trigger never meets this value from a payload.
--
-- A PROJECTION REBUILD (delete event_places, re-run the backfill) brings these
-- rows back as unresolved, exactly like the name pass's: re-run both passes
-- after it. The place_resolutions rows stay, append-only.
--
-- The lists are written in full, in 0250's order with the new value last, and
-- mirrored in db/schema.ts (eventPlaces / placeResolutions methodValid, by the
-- names Postgres gave them — __tests__/schema-check-parity.test.ts) and in
-- lib/domain/place.ts EVENT_PLACE_METHODS.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD). The old CHECKs are
-- dropped by NAME, so the closing block verifies by SHAPE: any CHECK left on
-- either table that lists the method vocabulary without the new value (a differently
-- named survivor of a drizzle push, say) would still refuse it, and fails the
-- migration instead. Forward-only. Rollback: a forward migration may narrow
-- the lists again once no row carries the value.
-- ────────────────────────────────────────────────────────────────────────────

-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock and validates every row: wait
-- for the lock briefly, never queue every reader of the table behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.event_places DROP CONSTRAINT IF EXISTS event_places_method_check;
ALTER TABLE public.event_places
  ADD CONSTRAINT event_places_method_check CHECK (method IN (
    'indec_id', 'catalogue_id', 'exact_name_unique',
    'folded_name_unique', 'geocode_unique', 'user_picked',
    'spine_rederived', 'legacy_unique_name', 'admin_queue',
    'unresolved', 'homonym_by_coordinates'));

ALTER TABLE public.place_resolutions DROP CONSTRAINT IF EXISTS place_resolutions_method_check;
ALTER TABLE public.place_resolutions
  ADD CONSTRAINT place_resolutions_method_check CHECK (method IN (
    'indec_id', 'catalogue_id', 'exact_name_unique',
    'folded_name_unique', 'geocode_unique', 'user_picked',
    'spine_rederived', 'legacy_unique_name', 'admin_queue',
    'unresolved', 'homonym_by_coordinates'));

DO $$
DECLARE
  stale text;
BEGIN
  SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ')
    INTO stale
    FROM pg_catalog.pg_constraint c
   WHERE c.contype = 'c'
     AND c.conrelid IN ('public.event_places'::regclass, 'public.place_resolutions'::regclass)
     -- A vocabulary CHECK (it lists the methods; admin_queue is in every list
     -- since 0250), not the (method = 'unresolved') = (locality_id IS NULL) one.
     AND pg_get_constraintdef(c.oid) ~ '\mmethod\M'
     AND pg_get_constraintdef(c.oid) ~ 'admin_queue'
     AND pg_get_constraintdef(c.oid) !~ 'homonym_by_coordinates';
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION '0291: CHECK(s) on method still refuse homonym_by_coordinates: %', stale;
  END IF;
END
$$;
