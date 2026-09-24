-- Canonicalize jurisdiction_province across all tables (handoff P6 / critique §Bug 2).
--
-- Storage format: PROVINCES[i].name from lib/ar-provincias.ts (display name).
-- Examples: "Buenos Aires", "CABA", "Mendoza".
--
-- This migration:
--   1. Backfills rows that hold ISO codes ("AR-B"), INDEC long form
--      ("Ciudad Autónoma de Buenos Aires"), or known aliases ("Capital Federal",
--      "Bs As") into the canonical display name.
--   2. Adds a CHECK constraint on each table enforcing the 24-value enum.
--
-- Why display name (not ISO):
--   - Existing reader code (govt dashboards, k-anonymity rollups) already
--     groups on display names.
--   - Error messages, audit logs, and the column itself stay human-readable.
--
-- Tables affected:
--   pets, organizations, organization_coverage, welfare_reports,
--   govt_assignments, approval_requests, govt_business_rules,
--   service_offerings, foster_volunteers, custody_disputes, cases.
--
-- pet_events.payload (jsonb) is intentionally left untouched — the event log
-- is append-only and historical payloads may legitimately reflect the
-- pre-canonicalization state of the world.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Backfill helper: normalize() takes any input shape and returns the canonical
-- display name (or NULL if unresolvable). Implemented as a temporary plpgsql
-- function so each UPDATE can reuse it.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.canonicalize_province(input text) RETURNS text AS $$
DECLARE
  s text;
  result text;
BEGIN
  IF input IS NULL OR length(trim(input)) = 0 THEN
    RETURN NULL;
  END IF;
  s := lower(unaccent(trim(input)));

  -- Exact canonical-name matches (case-insensitive, accent-insensitive).
  result := CASE s
    WHEN 'buenos aires'           THEN 'Buenos Aires'
    WHEN 'caba'                   THEN 'CABA'
    WHEN 'catamarca'              THEN 'Catamarca'
    WHEN 'chaco'                  THEN 'Chaco'
    WHEN 'chubut'                 THEN 'Chubut'
    WHEN 'cordoba'                THEN 'Córdoba'
    WHEN 'corrientes'             THEN 'Corrientes'
    WHEN 'entre rios'             THEN 'Entre Ríos'
    WHEN 'formosa'                THEN 'Formosa'
    WHEN 'jujuy'                  THEN 'Jujuy'
    WHEN 'la pampa'               THEN 'La Pampa'
    WHEN 'la rioja'               THEN 'La Rioja'
    WHEN 'mendoza'                THEN 'Mendoza'
    WHEN 'misiones'               THEN 'Misiones'
    WHEN 'neuquen'                THEN 'Neuquén'
    WHEN 'rio negro'              THEN 'Río Negro'
    WHEN 'salta'                  THEN 'Salta'
    WHEN 'san juan'               THEN 'San Juan'
    WHEN 'san luis'               THEN 'San Luis'
    WHEN 'santa cruz'             THEN 'Santa Cruz'
    WHEN 'santa fe'               THEN 'Santa Fe'
    WHEN 'santiago del estero'    THEN 'Santiago del Estero'
    WHEN 'tierra del fuego'       THEN 'Tierra del Fuego'
    WHEN 'tucuman'                THEN 'Tucumán'
    ELSE NULL
  END;
  IF result IS NOT NULL THEN RETURN result; END IF;

  -- ISO codes.
  result := CASE upper(trim(input))
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
    ELSE NULL
  END;
  IF result IS NOT NULL THEN RETURN result; END IF;

  -- Common aliases.
  result := CASE s
    WHEN 'cabba'                                 THEN 'CABA'
    WHEN 'capital'                               THEN 'CABA'
    WHEN 'capital federal'                       THEN 'CABA'
    WHEN 'ciudad autonoma de buenos aires'       THEN 'CABA'
    WHEN 'ciudad de buenos aires'                THEN 'CABA'
    WHEN 'bs as'                                 THEN 'Buenos Aires'
    WHEN 'bs aires'                              THEN 'Buenos Aires'
    WHEN 'provincia de buenos aires'             THEN 'Buenos Aires'
    ELSE NULL
  END;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- Ensure unaccent is available (idempotent — most Supabase projects have it).
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS unaccent;

-- ────────────────────────────────────────────────────────────────────────────
-- Backfill each table. UPDATE only rows where canonicalize_province produces
-- a *different* value (and is non-null) — preserves NULL and skips already-
-- canonical rows.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE pets                  SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE organizations         SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE organization_coverage SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE welfare_reports       SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE govt_assignments      SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE approval_requests     SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE govt_business_rules   SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE service_offerings     SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE foster_volunteers     SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE custody_disputes      SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

UPDATE cases                 SET jurisdiction_province = pg_temp.canonicalize_province(jurisdiction_province)
  WHERE jurisdiction_province IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) IS NOT NULL
    AND pg_temp.canonicalize_province(jurisdiction_province) <> jurisdiction_province;

-- ────────────────────────────────────────────────────────────────────────────
-- CHECK constraints. NULL is allowed (most columns are nullable); non-null
-- values must match one of the 24 canonical display names.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  tables text[] := ARRAY[
    'pets', 'organizations', 'organization_coverage', 'welfare_reports',
    'govt_assignments', 'approval_requests', 'govt_business_rules',
    'service_offerings', 'foster_volunteers', 'custody_disputes', 'cases'
  ];
  t text;
  enum_list constant text :=
    $list$jurisdiction_province IS NULL OR jurisdiction_province IN (
      'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba','Corrientes',
      'Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja','Mendoza','Misiones',
      'Neuquén','Río Negro','Salta','San Juan','San Luis','Santa Cruz','Santa Fe',
      'Santiago del Estero','Tierra del Fuego','Tucumán'
    )$list$;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_jurisdiction_province_canonical'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)',
      t, t || '_jurisdiction_province_canonical', enum_list
    );
  END LOOP;
END
$$;

COMMIT;
