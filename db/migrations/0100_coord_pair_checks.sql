-- Migration 0100: coordinate-pair consistency CHECK constraints
-- Ensures lat and lng are always stored together or not at all, mirroring
-- the existing organizations_coordinates_pair_check constraint.
--
-- Uses NOT VALID so the constraint governs NEW writes immediately without
-- scanning existing rows (which may contain half-null pairs from earlier
-- data entry). Once data quality is confirmed clean, run:
--   VALIDATE CONSTRAINT pet_events_location_pair_check;
--   VALIDATE CONSTRAINT welfare_reports_location_pair_check;
-- to backfill enforcement on historical rows.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pet_events_location_pair_check'
      AND conrelid = 'public.pet_events'::regclass
  ) THEN
    ALTER TABLE public.pet_events
      ADD CONSTRAINT pet_events_location_pair_check
      CHECK ((location_lat IS NULL) = (location_lng IS NULL))
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'welfare_reports_location_pair_check'
      AND conrelid = 'public.welfare_reports'::regclass
  ) THEN
    ALTER TABLE public.welfare_reports
      ADD CONSTRAINT welfare_reports_location_pair_check
      CHECK ((location_lat IS NULL) = (location_lng IS NULL))
      NOT VALID;
  END IF;
END;
$$;

-- optional: VALIDATE CONSTRAINT pet_events_location_pair_check;
-- optional: VALIDATE CONSTRAINT welfare_reports_location_pair_check;

COMMIT;
