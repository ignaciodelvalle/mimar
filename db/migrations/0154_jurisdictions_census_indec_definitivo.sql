-- INDEC Censo 2022 — replace provisional/partial jurisdictions_census populations
-- with the DEFINITIVE 24-jurisdiction totals.
--
-- Migration 0067 seeded jurisdictions_census with 17 provisional estimates
-- (marked TODO(verify)) + 7 confirmed figures. This migration UPDATEs all 24
-- rows to the INDEC final release, replacing every provisional estimate and
-- reconfirming the 7 that were already correct-or-close.
--
-- Source: INDEC, Censo Nacional de Población, Hogares y Viviendas 2022 —
-- Resultados definitivos, Cuadro resumen (columna "Total de población").
-- Census date: 2022-05-18. Publicación de resultados definitivos: 2023-11-21.
-- https://censo.gob.ar/wp-content/uploads/2024/01/c2022_tp_c_resumen.xlsx
--
-- Measure: "Total de población" = población censada (viviendas particulares +
-- colectivas + situación de calle). This is the measure INDEC desagrega por
-- provincia/departamento, and the correct denominator for a per-cápita KPI
-- over the whole population.
--
-- NOT used here: the national total WITH adjustment for census omission
-- (46.234.830) — that is INDEC's population-projections base figure, a
-- DIFFERENT measure, and is not broken down by jurisdiction. If a national
-- (not per-jurisdiction) KPI ever adopts that adjusted figure, it must be
-- clearly labeled as a distinct measure from this table.
--
-- Sum validation: the 24 rows below sum to exactly 45.892.285, the INDEC
-- national censada total (verified: node script summed the source JSON —
-- datos-investigados-2026-07-18/poblacion-provincias-censo2022.json — and it
-- matches `total_nacional_censada` exactly).
--
-- codigo_indec ↔ ar_provinces mapping validation (per the research package's
-- README §"Validación sugerida"): the repo has NO ar_provinces table with
-- INDEC 2-digit numeric codes — the canonical province identifier is the ISO
-- 3166-2:AR code in lib/reference/ar-provincias.ts (PROVINCES). Cross-checked
-- all 24 source jurisdiction names against PROVINCES via the existing
-- alias-tolerant provinceByName() resolver:
--   - 23 of 24 names match directly or via an EXISTING alias (e.g. "Ciudad
--     Autónoma de Buenos Aires" → CABA, already in ALIAS_TO_CODE).
--   - 1 exception: the source's official long form "Tierra del Fuego,
--     Antártida e Islas del Atlántico Sur" does NOT resolve through
--     provinceByName (no matching alias) — mapped manually below to the
--     canonical short name "Tierra del Fuego" already used by migration 0067
--     and lib/reference/ar-provincias.ts. This is the exact case the
--     research README flagged in advance ("salvo Tierra del Fuego/Antártida,
--     donde conviene fijar el criterio") — not a data inconsistency, a known
--     naming variance with an unambiguous resolution.
-- No other mismatch found; safe to proceed.
--
-- province_name values below are the same 24 canonical display names already
-- present in the table (seeded by migration 0067) — this migration only
-- UPDATEs population + source, it does not touch the row set or census_year.
--
-- Ignacio-gated: this migration is written but NOT applied to any database.

BEGIN;

UPDATE jurisdictions_census SET population = 17523996,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Buenos Aires';

UPDATE jurisdictions_census SET population = 3121707,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'CABA';

UPDATE jurisdictions_census SET population = 429562,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Catamarca';

UPDATE jurisdictions_census SET population = 1129606,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Chaco';

UPDATE jurisdictions_census SET population = 592621,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Chubut';

UPDATE jurisdictions_census SET population = 3840905,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Córdoba';

UPDATE jurisdictions_census SET population = 1212696,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Corrientes';

UPDATE jurisdictions_census SET population = 1425578,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Entre Ríos';

UPDATE jurisdictions_census SET population = 607419,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Formosa';

UPDATE jurisdictions_census SET population = 811611,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Jujuy';

UPDATE jurisdictions_census SET population = 361859,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'La Pampa';

UPDATE jurisdictions_census SET population = 383865,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'La Rioja';

UPDATE jurisdictions_census SET population = 2043540,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Mendoza';

UPDATE jurisdictions_census SET population = 1278873,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Misiones';

UPDATE jurisdictions_census SET population = 710814,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Neuquén';

UPDATE jurisdictions_census SET population = 750768,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Río Negro';

UPDATE jurisdictions_census SET population = 1441351,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Salta';

UPDATE jurisdictions_census SET population = 822853,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'San Juan';

UPDATE jurisdictions_census SET population = 542069,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'San Luis';

UPDATE jurisdictions_census SET population = 337226,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Santa Cruz';

UPDATE jurisdictions_census SET population = 3544908,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Santa Fe';

UPDATE jurisdictions_census SET population = 1060906,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Santiago del Estero';

-- Source long form: "Tierra del Fuego, Antártida e Islas del Atlántico Sur"
-- (codigo_indec "94") — mapped to the canonical short name (see header note).
UPDATE jurisdictions_census SET population = 185732,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Tierra del Fuego';

UPDATE jurisdictions_census SET population = 1731820,
  source = 'INDEC Censo 2022 (definitivo) — Total de población'
  WHERE province_name = 'Tucumán';

COMMIT;
