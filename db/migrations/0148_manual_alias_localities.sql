-- ────────────────────────────────────────────────────────────────────────────
-- 0148_manual_alias_localities.sql
-- INDEC granularity gap — manual alias localities (B3).
--
-- WHY
-- ---
-- A handful of colloquial place names that citizens type are NOT catalogued by
-- INDEC as distinct localities, so the strict resolver (localityByName /
-- normNameSql) misses them and their rows never get a locality_id FK
-- (migration 0147). The fix is additive and query-free: insert source='manual'
-- rows into ar_localities carrying the PARENT locality's department_code +
-- centroid. The existing (province_code, locality_name_norm) join then resolves
-- them for free — no new table, no query change, no resolver change.
--
-- The generated column locality_name_norm auto-populates from locality_name
-- ('olivos', 'belgrano r'), and locality_slug matches what localityByName's
-- slug-first lookup builds ('olivos', 'belgrano-r').
--
--   Olivos     → Vicente López partido (dept 06861, prov Buenos Aires / AR-B)
--   Belgrano R → Belgrano barrio (CABA / AR-C; CABA barrios carry no dept code,
--                mirroring the parent caba_open_data row)
--
-- indec_id is NULL (these are not INDEC entries); the unique constraint on
-- indec_id permits nulls. category uses the ar_localities_category_valid set.
--
-- Idempotent: INSERT ... WHERE NOT EXISTS keyed on (province_code, locality_slug)
-- so a re-run is a no-op. After this lands, re-run scripts/backfill-locality-id.ts
-- to resolve the newly-catalogued residual.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO ar_localities
  (province_code, department_code, department_name, locality_name, locality_slug,
   category, source, latitude, longitude)
SELECT 'AR-B', '06861', 'Vicente López', 'Olivos', 'olivos',
       'localidad', 'manual', -34.5275558, -58.5030975
WHERE NOT EXISTS (
  SELECT 1 FROM ar_localities
  WHERE province_code = 'AR-B' AND locality_slug = 'olivos' AND removed_at IS NULL
);

INSERT INTO ar_localities
  (province_code, department_code, department_name, locality_name, locality_slug,
   category, source, latitude, longitude)
SELECT 'AR-C', NULL, NULL, 'Belgrano R', 'belgrano-r',
       'barrio', 'manual', -34.5547400, -58.4501700
WHERE NOT EXISTS (
  SELECT 1 FROM ar_localities
  WHERE province_code = 'AR-C' AND locality_slug = 'belgrano-r' AND removed_at IS NULL
);
