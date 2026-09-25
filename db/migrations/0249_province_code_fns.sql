-- ────────────────────────────────────────────────────────────────────────────
-- 0249_province_code_fns.sql
-- One answer, in SQL, to "which ISO code is this province name?" — and back.
--
-- WHY (localidades-por-id B2, audit R12)
-- --------------------------------------
-- Migrations 0055, 0117, 0237 and 0246 each re-typed the 24-row province map
-- as a VALUES list, and the panorama and dashboard code carried two more
-- copies in TypeScript. Stage D keys scope, routing and the RLS policies on a
-- place's PROVINCE CODE next to its catalogue id, and the rows store the
-- canonical province NAME (CHECK 0055). Every SQL reader that needs the code
-- calls these two functions instead of writing the map a fifth time.
--
-- THE LIST is `PROVINCES` in packages/contract/src/reference/provinces.ts
-- (re-exported by lib/reference/ar-provincias.ts). These bodies are that list,
-- one pair per line; __tests__/province-map-single-source.test.ts calls both
-- functions for all 24 rows and compares, and scripts/
-- check-province-map-single-source.ts (lint:province-map) refuses any other
-- hand-written copy.
--
-- CANONICAL NAMES ONLY. The stored columns hold the canonical display name
-- (CHECK 0055), so anything else — an alias, a long form, a typo — answers
-- NULL. Alias tolerance is an INPUT concern (`provinceByName`), never a
-- storage one.
--
-- IMMUTABLE + LANGUAGE sql: inlinable into index expressions and RLS
-- predicates, no SECURITY DEFINER (they read nothing).
--
-- Idempotent (CREATE OR REPLACE). Forward-only. Rollback: a forward migration
-- drops them; nothing reads them until B5 / stage D.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ar_province_code(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_name
    WHEN 'Buenos Aires' THEN 'AR-B'
    WHEN 'CABA' THEN 'AR-C'
    WHEN 'Catamarca' THEN 'AR-K'
    WHEN 'Chaco' THEN 'AR-H'
    WHEN 'Chubut' THEN 'AR-U'
    WHEN 'Córdoba' THEN 'AR-X'
    WHEN 'Corrientes' THEN 'AR-W'
    WHEN 'Entre Ríos' THEN 'AR-E'
    WHEN 'Formosa' THEN 'AR-P'
    WHEN 'Jujuy' THEN 'AR-Y'
    WHEN 'La Pampa' THEN 'AR-L'
    WHEN 'La Rioja' THEN 'AR-F'
    WHEN 'Mendoza' THEN 'AR-M'
    WHEN 'Misiones' THEN 'AR-N'
    WHEN 'Neuquén' THEN 'AR-Q'
    WHEN 'Río Negro' THEN 'AR-R'
    WHEN 'Salta' THEN 'AR-A'
    WHEN 'San Juan' THEN 'AR-J'
    WHEN 'San Luis' THEN 'AR-D'
    WHEN 'Santa Cruz' THEN 'AR-Z'
    WHEN 'Santa Fe' THEN 'AR-S'
    WHEN 'Santiago del Estero' THEN 'AR-G'
    WHEN 'Tierra del Fuego' THEN 'AR-V'
    WHEN 'Tucumán' THEN 'AR-T'
  END
$$;

CREATE OR REPLACE FUNCTION public.ar_province_name(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_code
    WHEN 'AR-B' THEN 'Buenos Aires'
    WHEN 'AR-C' THEN 'CABA'
    WHEN 'AR-K' THEN 'Catamarca'
    WHEN 'AR-H' THEN 'Chaco'
    WHEN 'AR-U' THEN 'Chubut'
    WHEN 'AR-X' THEN 'Córdoba'
    WHEN 'AR-W' THEN 'Corrientes'
    WHEN 'AR-E' THEN 'Entre Ríos'
    WHEN 'AR-P' THEN 'Formosa'
    WHEN 'AR-Y' THEN 'Jujuy'
    WHEN 'AR-L' THEN 'La Pampa'
    WHEN 'AR-F' THEN 'La Rioja'
    WHEN 'AR-M' THEN 'Mendoza'
    WHEN 'AR-N' THEN 'Misiones'
    WHEN 'AR-Q' THEN 'Neuquén'
    WHEN 'AR-R' THEN 'Río Negro'
    WHEN 'AR-A' THEN 'Salta'
    WHEN 'AR-J' THEN 'San Juan'
    WHEN 'AR-D' THEN 'San Luis'
    WHEN 'AR-Z' THEN 'Santa Cruz'
    WHEN 'AR-S' THEN 'Santa Fe'
    WHEN 'AR-G' THEN 'Santiago del Estero'
    WHEN 'AR-V' THEN 'Tierra del Fuego'
    WHEN 'AR-T' THEN 'Tucumán'
  END
$$;

COMMENT ON FUNCTION public.ar_province_code(text) IS
  'Canonical province display name -> ISO 3166-2:AR code; NULL for anything else. Source list: packages/contract/src/reference/provinces.ts. localidades-por-id B2.';
COMMENT ON FUNCTION public.ar_province_name(text) IS
  'ISO 3166-2:AR code -> canonical province display name; NULL for anything else. Source list: packages/contract/src/reference/provinces.ts. localidades-por-id B2.';
