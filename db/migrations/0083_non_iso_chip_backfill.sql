-- Migration 0083: non-ISO legacy chip backfill
--
-- Context: migration 0082 backfilled canonical pet_identifications rows for
-- pets with ISO-conforming chips (15 digits, all numeric). It explicitly
-- SKIPped non-conforming chip codes to avoid violating the
-- chip_requires_iso_fields CHECK constraint — which gates isoCompliant=true
-- inserts on having the three ISO decomposition fields populated.
--
-- This migration covers the gap: any pet whose pets.microchip_id is set
-- but whose code is NOT 15-digit numeric (legacy/non-ISO format) and who
-- has NO active microchip_iso canonical row gets a canonical row inserted
-- with isoCompliant=false and ISO decomposition fields NULL.
--
-- Idempotent: guarded by NOT EXISTS (same pattern as 0082).
-- recordedByLabel = 'legacy_backfill_0083' (distinct provenance sentinel).
--
-- Tattoo backfill: 0082's tattoo backfill was unconditional on code format
-- (tattoo codes are free-text — no ISO constraint). Any remaining tattoo gaps
-- are therefore 0082 NOT EXISTS guard misses, not a format-gating issue.
-- The same unconditional style is repeated here for safety, but in practice
-- 0082 should have covered all tattoo gaps already.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Non-ISO microchip backfill
--
-- Pets with a microchip_id value that does NOT conform to ISO 11784/11785
-- (not exactly 15 all-numeric digits) and that have no active microchip_iso
-- canonical row. Insert with isoCompliant=false; ISO decomposition columns
-- are left NULL (they would violate the constraint otherwise, and they're
-- genuinely unknown for non-standard chip codes).
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO public.pet_identifications (
  pet_id, kind, status, code,
  recorded_at, recorded_by_label,
  iso_compliant,
  implantation_site
)
SELECT
  p.id,
  'microchip_iso',
  'active',
  p.microchip_id,
  COALESCE(p.microchip_implanted_at, p.created_at::date, current_date),
  'legacy_backfill_0083',
  false,
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
  AND NOT (length(p.microchip_id) = 15 AND p.microchip_id ~ '^[0-9]{15}$')
  AND NOT EXISTS (
    SELECT 1 FROM public.pet_identifications pi
     WHERE pi.pet_id = p.id
       AND pi.kind = 'microchip_iso'
       AND pi.status = 'active'
  );

-- ─────────────────────────────────────────────────────────────────────────
-- Safety tattoo backfill (catchall — 0082 should have covered these already)
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
        'legacy_backfill_0083',
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
-- Verification DO block — RAISES if any pets.microchip_id remains without
-- an active canonical row. After this backfill completeness must be total.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  chip_gap_count  bigint;
  tattoo_gap_count bigint;
BEGIN
  SELECT count(*) INTO chip_gap_count
    FROM public.pets p
   WHERE p.microchip_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.pet_identifications pi
        WHERE pi.pet_id = p.id
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
     );

  IF chip_gap_count > 0 THEN
    RAISE EXCEPTION
      'migration 0083 verification failed: % pet(s) still have microchip_id with no active canonical row',
      chip_gap_count;
  END IF;

  -- Tattoo gap check (informational — column may be absent on older schemas).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pets' AND column_name = 'tattoo_code'
  ) THEN
    EXECUTE $sql$
      SELECT count(*) FROM public.pets p
       WHERE p.tattoo_code IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.pet_identifications pi
            WHERE pi.pet_id = p.id
              AND pi.kind = 'tattoo'
              AND pi.status = 'active'
         )
    $sql$ INTO tattoo_gap_count;

    IF tattoo_gap_count > 0 THEN
      RAISE EXCEPTION
        'migration 0083 verification failed: % pet(s) still have tattoo_code with no active canonical row',
        tattoo_gap_count;
    END IF;
  END IF;
END $$;

COMMIT;
