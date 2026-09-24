-- Migration 0084: drop legacy chip/tattoo columns from pets.
--
-- ARCH-S: The 11 pets.* columns that cached microchip and tattoo data have been
-- superseded by the canonical pet_identifications table (introduced in 0077).
-- All application reads and writes were migrated to pet_identifications across
-- ARCH-Q through ARCH-R; this migration drops the now-unused columns and their
-- dependent indexes/constraints.
--
-- Columns dropped:
--   microchip_id, microchip_country_code, microchip_implanted_at,
--   microchip_implanted_by, microchip_location,
--   tattoo_code, tattoo_location, tattoo_description,
--   tattoo_recorded_at, tattoo_recorded_by, tattoo_photo_id
--
-- Dependent objects dropped first (IF EXISTS guards for idempotency):
--   INDEX  pets_microchip_unique_when_present  (partial unique on microchip_id)
--   INDEX  pets_microchip_lookup_idx           (non-unique lookup index from 0012)
--   INDEX  pets_tattoo_code_idx               (partial index on tattoo_code)
--   CHECK  pets_tattoo_location_valid         (tattoo_location enum guard)

-- 1. Drop the partial unique index on microchip_id.
DROP INDEX IF EXISTS pets_microchip_unique_when_present;

-- 1b. Drop the non-unique lookup index on microchip_id created by 0012.
--     Without this, the DROP COLUMN below fails with "other objects depend on it"
--     when migrations are replayed on a fresh DB (migration-first order, not
--     drizzle-kit-push-first). Added here (post-apply) rather than a new
--     migration because the column no longer exists on already-bootstrapped DBs
--     and the IF EXISTS guard makes this idempotent.
DROP INDEX IF EXISTS pets_microchip_lookup_idx;

-- 2. Drop the partial index on tattoo_code.
DROP INDEX IF EXISTS pets_tattoo_code_idx;

-- 3. Drop the CHECK constraint on tattoo_location.
ALTER TABLE pets DROP CONSTRAINT IF EXISTS pets_tattoo_location_valid;

-- 4. Drop the 11 legacy columns.
ALTER TABLE pets
  DROP COLUMN IF EXISTS microchip_id,
  DROP COLUMN IF EXISTS microchip_country_code,
  DROP COLUMN IF EXISTS microchip_implanted_at,
  DROP COLUMN IF EXISTS microchip_implanted_by,
  DROP COLUMN IF EXISTS microchip_location,
  DROP COLUMN IF EXISTS tattoo_code,
  DROP COLUMN IF EXISTS tattoo_location,
  DROP COLUMN IF EXISTS tattoo_description,
  DROP COLUMN IF EXISTS tattoo_recorded_at,
  DROP COLUMN IF EXISTS tattoo_recorded_by,
  DROP COLUMN IF EXISTS tattoo_photo_id;
