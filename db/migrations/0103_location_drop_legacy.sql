-- Migration 0103: location column convergence (DEPLOY 2 — contract phase, DESTRUCTIVE).
--
-- Drops the legacy coordinate columns now that all code reads/writes only the
-- canonical location_lat/location_lng numeric(10,7) columns added in 0101.
--
-- Pre-conditions (must be verified before running on remote):
--   1. Migration 0101 is applied and all canonical columns are populated.
--   2. All app code no longer reads latitude/longitude or primary_location_lat/lng.
--   3. Phase B code rotation (PR #646) is merged and deployed to production.
--   4. Owner sign-off (Nacho) obtained.
--
-- ROLLBACK: Column drops are not reversible via migration.
--           Restore from Supabase point-in-time recovery if needed.
--
-- GATED: Do NOT run on the remote production DB without owner sign-off.
--        Safe to apply locally via `pnpm db:reset` + `pnpm db:bootstrap`.

BEGIN;

-- Validate pair-check constraints added as NOT VALID in migration 0101.
-- Full-table scan is safe now: backfill ran, code is rotated to canonical-only.
ALTER TABLE public.cases
  VALIDATE CONSTRAINT cases_location_pair_check;

ALTER TABLE public.organizations
  VALIDATE CONSTRAINT organizations_location_pair_check;

-- Fix the subject-location consistency constraint (originally added in 0033).
-- The old definition referenced the legacy primary_location_lat/lng columns.
-- Rewrite it to reference the canonical location_lat/lng columns so that
-- dropping the legacy columns below does not cascade-drop the constraint.
ALTER TABLE public.cases
  DROP CONSTRAINT cases_subject_location_consistency;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_subject_location_consistency
  CHECK (
    (primary_subject_kind = 'location')
    = (location_lat IS NOT NULL AND location_lng IS NOT NULL)
  );

-- Drop legacy organizations coordinate columns.
-- Superseded by location_lat/lng numeric(10,7) added in 0101.
-- organizations.latitude/longitude were numeric(9,6) — less precision.
ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude;

-- Drop legacy cases coordinate columns.
-- Superseded by location_lat/lng numeric(10,7) added in 0101.
ALTER TABLE public.cases
  DROP COLUMN IF EXISTS primary_location_lat,
  DROP COLUMN IF EXISTS primary_location_lng;

COMMIT;
