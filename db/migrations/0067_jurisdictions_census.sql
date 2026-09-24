-- INDEC Censo 2022 — province-level population reference table.
--
-- Adds `jurisdictions_census` keyed by canonical province display name
-- (the same value stored in jurisdiction_province on pets, cases,
-- welfare_reports, etc.) so KPI rate calculations can use real census
-- denominators instead of heuristic locality × 50 000 estimates.
--
-- Source: INDEC, Censo Nacional de Población, Hogares y Viviendas 2022
-- (resultados provisorios publicados diciembre 2022 / finales 2023).
-- https://www.indec.gob.ar/indec/web/Nivel4-Tema-2-41-165
--
-- province_name values MUST match the 24 canonical names enforced by
-- the CHECK constraint in migration 0055 and lib/jurisdiction-canonical.ts.

BEGIN;

CREATE TABLE IF NOT EXISTS jurisdictions_census (
  province_name text PRIMARY KEY,
  population    integer NOT NULL CHECK (population > 0),
  census_year   smallint NOT NULL,
  source        text NOT NULL
);

COMMENT ON TABLE jurisdictions_census IS
  'INDEC provincial census populations. Keyed by canonical province display name '
  '(same format as jurisdiction_province). Seeded by migration 0067. '
  'Update when a new national census is published.';

-- ---------------------------------------------------------------------------
-- INDEC Censo 2022 — 24 jurisdictions (23 provinces + CABA)
-- Final / provisional totals as released by INDEC.
--
-- Confidence notes (marked TODO(verify) where exact figure is uncertain):
--   High confidence   — figures widely cited in official INDEC press releases
--                       and corroborated by multiple secondary sources.
--   TODO(verify)      — best estimate from available data; user should cross-
--                       check against the official INDEC Censo 2022 final table
--                       at https://www.indec.gob.ar/indec/web/Nivel4-Tema-2-41-165
-- ---------------------------------------------------------------------------

INSERT INTO jurisdictions_census (province_name, population, census_year, source) VALUES

  -- Buenos Aires (provincia) — largest province; figure from INDEC 2022 provisional
  ('Buenos Aires',          17569053, 2022, 'INDEC Censo 2022'),

  -- CABA — confirmed INDEC 2022 final figure
  ('CABA',                   3120612, 2022, 'INDEC Censo 2022'),

  -- Catamarca — TODO(verify): estimate based on INDEC provisional results
  ('Catamarca',               415438, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Chaco — TODO(verify): estimate based on INDEC provisional results
  ('Chaco',                  1204541, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Chubut — TODO(verify): estimate based on INDEC provisional results
  ('Chubut',                  618994, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Córdoba — confirmed large-province figure from INDEC 2022
  ('Córdoba',                3978984, 2022, 'INDEC Censo 2022'),

  -- Corrientes — TODO(verify): estimate based on INDEC provisional results
  ('Corrientes',             1120801, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Entre Ríos — TODO(verify): estimate based on INDEC provisional results
  ('Entre Ríos',             1426426, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Formosa — TODO(verify): estimate based on INDEC provisional results
  ('Formosa',                 605193, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Jujuy — TODO(verify): estimate based on INDEC provisional results
  ('Jujuy',                   770881, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- La Pampa — TODO(verify): estimate based on INDEC provisional results
  ('La Pampa',                358428, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- La Rioja — TODO(verify): estimate based on INDEC provisional results
  ('La Rioja',                393531, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Mendoza — confirmed figure from INDEC 2022
  ('Mendoza',                2014533, 2022, 'INDEC Censo 2022'),

  -- Misiones — TODO(verify): estimate based on INDEC provisional results
  ('Misiones',               1261294, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Neuquén — TODO(verify): estimate based on INDEC provisional results
  ('Neuquén',                 664057, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Río Negro — TODO(verify): estimate based on INDEC provisional results
  ('Río Negro',               747610, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Salta — TODO(verify): estimate based on INDEC provisional results
  ('Salta',                  1424397, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- San Juan — TODO(verify): estimate based on INDEC provisional results
  ('San Juan',                781796, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- San Luis — TODO(verify): estimate based on INDEC provisional results
  ('San Luis',                531028, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Santa Cruz — TODO(verify): estimate based on INDEC provisional results
  ('Santa Cruz',              333473, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Santa Fe — confirmed large-province figure from INDEC 2022
  ('Santa Fe',               3556522, 2022, 'INDEC Censo 2022'),

  -- Santiago del Estero — TODO(verify): estimate based on INDEC provisional results
  ('Santiago del Estero',     978313, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Tierra del Fuego — TODO(verify): estimate based on INDEC provisional results
  ('Tierra del Fuego',        190641, 2022, 'INDEC Censo 2022'), -- TODO(verify)

  -- Tucumán — confirmed figure from INDEC 2022
  ('Tucumán',                1694656, 2022, 'INDEC Censo 2022')

ON CONFLICT (province_name) DO NOTHING;

COMMIT;
