-- Migration 0101: location column convergence (DEPLOY 1 — additive + backfill).
--
-- Adds canonical location_lat/location_lng numeric(10,7) to `cases` and
-- `organizations`, backfills from the legacy columns, and adds NOT VALID pair
-- CHECKs on the NEW columns. OLD columns (cases.primary_location_*,
-- organizations.latitude/longitude) are LEFT IN PLACE and keep their existing
-- constraints — they are dropped in a LATER deploy once all code is rotated.
--
-- orgs widen 9,6 -> 10,7 is a lossless widening done by the UPDATE cast.

BEGIN;

ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS location_lat numeric(10, 7),
  ADD COLUMN IF NOT EXISTS location_lng numeric(10, 7);

UPDATE public.cases
  SET location_lat = primary_location_lat,
      location_lng = primary_location_lng
  WHERE location_lat IS NULL
    AND location_lng IS NULL
    AND (primary_location_lat IS NOT NULL OR primary_location_lng IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cases_location_pair_check'
      AND conrelid = 'public.cases'::regclass
  ) THEN
    ALTER TABLE public.cases
      ADD CONSTRAINT cases_location_pair_check
      CHECK ((location_lat IS NULL) = (location_lng IS NULL))
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS location_lat numeric(10, 7),
  ADD COLUMN IF NOT EXISTS location_lng numeric(10, 7);

UPDATE public.organizations
  SET location_lat = latitude,
      location_lng = longitude
  WHERE location_lat IS NULL
    AND location_lng IS NULL
    AND (latitude IS NOT NULL OR longitude IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_location_pair_check'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_location_pair_check
      CHECK ((location_lat IS NULL) = (location_lng IS NULL))
      NOT VALID;
  END IF;
END;
$$;

COMMIT;
