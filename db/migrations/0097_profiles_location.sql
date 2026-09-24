-- Migration 0097: add jurisdiction_province / jurisdiction_locality to profiles
--
-- Background
-- ----------
-- Captures coarse user location at registration (signup step 2) and allows
-- regional health-campaign targeting without storing precise coordinates.
-- Mirrors the nullable pattern used by pets.jurisdiction_province/locality.
--
-- The CHECK constraint reuses the same canonical province list that all other
-- jurisdiction_province columns carry (migration 0055, lib/ar-provincias.ts).
--
-- Both columns are nullable: existing rows remain valid with NULL values;
-- the UI collects them optionally at registration and via /cuenta.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS jurisdiction_province text,
  ADD COLUMN IF NOT EXISTS jurisdiction_locality  text;

-- Enforce canonical province name when non-null (same guard as pets, orgs, etc.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname   = 'profiles_jurisdiction_province_canonical'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_jurisdiction_province_canonical
      CHECK (
        jurisdiction_province IS NULL OR jurisdiction_province IN (
          'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba','Corrientes',
          'Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja','Mendoza','Misiones',
          'Neuquén','Río Negro','Salta','San Juan','San Luis','Santa Cruz','Santa Fe',
          'Santiago del Estero','Tierra del Fuego','Tucumán'
        )
      );
  END IF;
END;
$$;
