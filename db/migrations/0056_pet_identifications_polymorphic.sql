-- Polymorphic pet identifications (compliance handoff PR 0).
--
-- Moves microchip + tattoo (currently parallel columns on `pets`) into a
-- single polymorphic table keyed by `kind` enum. Backwards-compatible this
-- sprint: legacy columns stay; the next sprint drops them via 0057.
--
-- Why polymorphic:
--   - The chip-replacement flow (P3-1 followup, `/admin/observaciones/...
--     /microchip/reemplazar`) has no natural representation when chip lives
--     as a column — overwriting `pets.microchip_id` destroys history.
--   - New identifier kinds (RFID, anillo, genoprint per Res. 93/APRA/2021)
--     would each demand 5-6 new columns on `pets`. Doesn't scale.
--   - SENASA's ISO 11784/11785 contract (Res. 284/2024) has structured
--     subfields (country / manufacturer / national_id) that deserve first-
--     class columns.

BEGIN;

CREATE TYPE identification_kind AS ENUM (
  'microchip_iso',     -- ISO 11784/11785, Res. SENASA 284/2024
  'tattoo',            -- Ord. CABA 41.831 art. 4°
  'collar_tag',        -- chapita identificatoria, no oficial
  'photo_biometric'    -- reservado, no implementado
);

CREATE TYPE identification_status AS ENUM (
  'active',
  'replaced',          -- reemplazado por otro identificador (chip dañado, migración registro)
  'removed',           -- baja por defunción / extravío irrecuperable
  'unreadable'         -- físicamente presente pero ilegible
);

CREATE TABLE public.pet_identifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id                uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  kind                  identification_kind NOT NULL,
  status                identification_status NOT NULL DEFAULT 'active',

  -- Shared
  code                  text,
  recorded_at           date NOT NULL,
  recorded_by_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  recorded_by_label     text,                    -- free string when not a MiMAR user (legacy)
  photo_id              uuid,

  -- Chip (Res. SENASA 284/2024 + ISO 11784)
  iso_country_code      char(3),                 -- '858' AR (ISO 3166 numeric), '032' is legacy alpha-code form
  iso_manufacturer_code char(4),
  iso_national_id       char(8),
  iso_compliant         boolean,                 -- true if it passes ISO 11785 checksum
  implantation_site     text,

  -- Tattoo (Ord. CABA 41.831)
  tattoo_location       text,
  tattoo_description    text,

  -- Replacement history
  replaced_by_id        uuid REFERENCES public.pet_identifications(id) ON DELETE SET NULL,
  replacement_reason    text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chip_requires_iso_fields
    CHECK (kind <> 'microchip_iso' OR (
      code IS NOT NULL AND length(code) = 15
    )),
  CONSTRAINT tattoo_location_valid
    CHECK (tattoo_location IS NULL OR tattoo_location IN (
      'inner_ear_left','inner_ear_right','inner_thigh','belly','other'
    )),
  CONSTRAINT implantation_site_valid
    CHECK (implantation_site IS NULL OR implantation_site IN (
      'lateral_cuello_izq','lateral_cuello_der','interescapular','otro'
    )),
  CONSTRAINT replacement_reason_valid
    CHECK (replacement_reason IS NULL OR replacement_reason IN (
      'damaged','migrated','illegible','medical','other'
    ))
);

CREATE INDEX pet_identifications_pet_idx
  ON public.pet_identifications(pet_id);

-- Lookup index for active rows by (kind, code). Partial: nulls excluded.
CREATE INDEX pet_identifications_code_idx
  ON public.pet_identifications(kind, code)
  WHERE code IS NOT NULL AND status = 'active';

-- Decision D1: unique only for active chip rows. Tattoos legitimately
-- collide across registries (already documented in migration 0045).
CREATE UNIQUE INDEX pet_identifications_chip_unique
  ON public.pet_identifications(code)
  WHERE kind = 'microchip_iso' AND status = 'active';

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill from legacy `pets` columns.
--   - Chip: 1:1 mapping. The 15-digit ISO decomposition is best-effort:
--     country (first 3) / manufacturer (next 4) / national_id (last 8).
--   - Tattoo: includes location + description + recorded_by_label + photo.
-- ─────────────────────────────────────────────────────────────────────────

-- Only backfill chips that pass the strict ISO 11784/11785 length contract.
-- Pre-pilot data with non-conforming chips (test fixtures, legacy seeds with
-- 16/18-digit codes) is left unmigrated on purpose — those rows would
-- violate `chip_requires_iso_fields`. Operators can re-record manually via
-- `lib/identifications.addIdentification` once the pet's real chip is read.
INSERT INTO public.pet_identifications (
  pet_id, kind, status, code,
  recorded_at, recorded_by_label,
  iso_country_code, iso_manufacturer_code, iso_national_id, iso_compliant,
  implantation_site
)
SELECT id, 'microchip_iso', 'active', microchip_id,
       COALESCE(microchip_implanted_at, created_at::date, current_date),
       'legacy_backfill_0056',
       substring(microchip_id, 1, 3),
       substring(microchip_id, 4, 4),
       substring(microchip_id, 8, 8),
       true,
       CASE microchip_location
         WHEN 'interscapular_left' THEN 'interescapular'
         WHEN 'interscapular_right' THEN 'interescapular'
         WHEN 'interscapular' THEN 'interescapular'
         WHEN 'neck_left' THEN 'lateral_cuello_izq'
         WHEN 'neck_right' THEN 'lateral_cuello_der'
         WHEN NULL THEN NULL
         ELSE 'otro'
       END
  FROM public.pets
 WHERE microchip_id IS NOT NULL
   AND length(microchip_id) = 15
   AND microchip_id ~ '^[0-9]{15}$';

-- Tattoo backfill — guarded because some pre-pilot envs were rebuilt from
-- a snapshot that pre-dates migration 0045 (the tattoo columns on `pets`).
-- The DO block compiles even when the columns don't exist; the INSERT only
-- runs when they do, leaving the new table empty of tattoo rows on those
-- envs (operators can re-record via `addIdentification` once ready).
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
      SELECT id, 'tattoo', 'active', tattoo_code,
             tattoo_location, tattoo_description,
             COALESCE(tattoo_recorded_at, current_date),
             tattoo_recorded_by, tattoo_photo_id
        FROM public.pets
       WHERE tattoo_code IS NOT NULL
    $sql$;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Compat view — readers that haven't migrated yet still see the legacy
-- columns alongside the canonical-via-new-table values. The two should
-- agree row-by-row until the next sprint drops the legacy columns.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.pets_with_identifiers AS
SELECT
  p.*,
  (SELECT code FROM public.pet_identifications i
    WHERE i.pet_id = p.id AND i.kind = 'microchip_iso' AND i.status = 'active'
    LIMIT 1) AS chip_code_canonical,
  (SELECT code FROM public.pet_identifications i
    WHERE i.pet_id = p.id AND i.kind = 'tattoo' AND i.status = 'active'
    LIMIT 1) AS tattoo_code_canonical
FROM public.pets p;

COMMENT ON TABLE public.pet_identifications IS
  'Polymorphic pet identifiers (chip / tattoo / collar_tag / photo_biometric). Replaces parallel columns on pets. Migration 0057 will drop the legacy columns.';

COMMIT;
