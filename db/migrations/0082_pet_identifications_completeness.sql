-- Migration 0082: pet_identifications completeness backfill
--
-- Context: migration 0056 created pet_identifications and ran an initial backfill
-- from the legacy pets.* columns. However, 5 writer paths were never wired to
-- dual-write the canonical row:
--   1. createMicrochip (microchip-use-case.ts) — updateMicrochipBackfill path
--   2. setPetLost retroactive identifiers (set-pet-lost-use-case.ts)
--   3. replaceMicrochipForUser (app/actions/microchip.ts)
--   4. createIntakeAction (app/actions/intake.ts)
--   5. updatePetProfile chipNewlyAdded (pets-repository.ts)
--
-- This migration fills the gap: for every pet with a legacy identifier value
-- (microchip_id or tattoo_code) but no matching active canonical row, we insert
-- the derived canonical row using the same logic as migration 0056.
--
-- Remaining phases toward eventual legacy column drop (NOT this migration):
--   Phase 1 (ARCH-O+1): migrate lib/rederive-pet-cache.ts harness to read from
--     pet_identifications instead of pets.* legacy columns (currently the harness
--     is the drift detector — it reads all 10 legacy columns; dropping them before
--     rewriting the harness is circular).
--   Phase 2: migrate all readers (chip-lookup.ts, tattoo-lookup.ts, pet-tab-data.ts,
--     ppp-export-caba.ts, welfare-repository.ts, adoption-listing-read.ts,
--     lost-listing-read.ts, pet-claim.ts) to read from pet_identifications.
--   Phase 3: kill the legacy double-writes in tattoo.ts and pets-repository.ts
--     (registerPet path) — these already write BOTH places; once readers are off
--     the legacy columns, the legacy write can be removed.
--   Phase 4: add DROP COLUMN migration for all 10 legacy identifier columns.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Microchip backfill
--
-- Insert an active canonical row for every pet whose microchip_id is set
-- but has NO existing active microchip_iso row in pet_identifications.
-- Applies the same ISO decomposition and implantation_site mapping as 0056.
-- Skips non-conforming chip codes (not 15 digits, not all numeric) to avoid
-- violating the chip_requires_iso_fields CHECK constraint — same guard as 0056.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO public.pet_identifications (
  pet_id, kind, status, code,
  recorded_at, recorded_by_label,
  iso_country_code, iso_manufacturer_code, iso_national_id, iso_compliant,
  implantation_site
)
SELECT
  p.id,
  'microchip_iso',
  'active',
  p.microchip_id,
  COALESCE(p.microchip_implanted_at, p.created_at::date, current_date),
  'legacy_backfill_0082',
  substring(p.microchip_id, 1, 3),
  substring(p.microchip_id, 4, 4),
  substring(p.microchip_id, 8, 8),
  true,
  CASE p.microchip_location
    WHEN 'interscapular_left'  THEN 'interescapular'
    WHEN 'interscapular_right' THEN 'interescapular'
    WHEN 'interscapular'       THEN 'interescapular'
    WHEN 'neck_left'           THEN 'lateral_cuello_izq'
    WHEN 'neck_right'          THEN 'lateral_cuello_der'
    ELSE CASE WHEN p.microchip_location IS NOT NULL THEN 'otro' ELSE NULL END
  END
FROM public.pets p
WHERE p.microchip_id IS NOT NULL
  AND length(p.microchip_id) = 15
  AND p.microchip_id ~ '^[0-9]{15}$'
  AND NOT EXISTS (
    SELECT 1 FROM public.pet_identifications pi
     WHERE pi.pet_id = p.id
       AND pi.kind = 'microchip_iso'
       AND pi.status = 'active'
  );

-- ─────────────────────────────────────────────────────────────────────────
-- Tattoo backfill
--
-- Insert an active canonical row for every pet whose tattoo_code is set
-- but has NO existing active tattoo row in pet_identifications.
-- Guarded with an existence check on the tattoo_code column (same as 0056).
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pets' AND column_name = 'tattoo_code'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.pet_identifications (
        pet_id, kind, status, code,
        tattoo_location, tattoo_description,
        recorded_at, recorded_by_label, photo_id
      )
      SELECT
        p.id,
        'tattoo',
        'active',
        p.tattoo_code,
        p.tattoo_location,
        p.tattoo_description,
        COALESCE(p.tattoo_recorded_at, p.created_at::date, current_date),
        'legacy_backfill_0082',
        p.tattoo_photo_id
      FROM public.pets p
      WHERE p.tattoo_code IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.pet_identifications pi
           WHERE pi.pet_id = p.id
             AND pi.kind = 'tattoo'
             AND pi.status = 'active'
        )
    $sql$;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Verification query (informational — will not fail the migration).
-- After applying, run manually to confirm 0 rows remain:
--
--   SELECT 'microchip' AS kind, count(*) AS gap_count
--     FROM public.pets p
--    WHERE p.microchip_id IS NOT NULL
--      AND length(p.microchip_id) = 15
--      AND p.microchip_id ~ '^[0-9]{15}$'
--      AND NOT EXISTS (
--        SELECT 1 FROM public.pet_identifications pi
--         WHERE pi.pet_id = p.id AND pi.kind = 'microchip_iso' AND pi.status = 'active'
--      )
--   UNION ALL
--   SELECT 'tattoo', count(*)
--     FROM public.pets p
--    WHERE p.tattoo_code IS NOT NULL
--      AND NOT EXISTS (
--        SELECT 1 FROM public.pet_identifications pi
--         WHERE pi.pet_id = p.id AND pi.kind = 'tattoo' AND pi.status = 'active'
--      );
-- ─────────────────────────────────────────────────────────────────────────

COMMIT;
