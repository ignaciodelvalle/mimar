-- ────────────────────────────────────────────────────────────────────────────
-- 0147_locality_id_fk.sql
-- Additive nullable locality_id FK on pets / welfare_reports / cases.
--
-- WHY
-- ---
-- The panorama choropleth attributes an event to a department by name-normalizing
-- the FREE-TEXT jurisdiction_locality column against ar_localities.locality_name_norm
-- (migration 0146 made that join sargable). That name join is ~99.3% reliable but
-- structural erosion is inevitable as free text grows. This migration introduces
-- the STRUCTURAL join key: a nullable locality_id FK pointing at the ar_localities
-- primary key (uuid). Every ar_localities row has a uuid — including the 48 CABA
-- barrios whose indec_id is NULL — so this key can attribute rows the INDEC id
-- never could.
--
-- ADDITIVE / NULLABLE
-- -------------------
-- The free-text jurisdiction_locality / jurisdiction_province columns STAY: they
-- remain the display source and the backfill input, and the centroid fallback that
-- preserves "province total = sum of cells" depends on unresolved rows surviving
-- with a NULL FK. The FK is the NEW join key, not a replacement — nothing is
-- dropped, no existing read path changes.
--
-- The column is populated by:
--   - the write path (normalizeLocationForWrite threads the resolved id), and
--   - scripts/backfill-locality-id.ts for historical rows.
-- Rows that do not resolve stay NULL and keep rendering via the name join + centroid.
--
-- ON DELETE SET NULL: ar_localities rows are soft-deleted (removed_at), not hard
-- deleted, so this rarely fires; SET NULL keeps the additive/non-destructive
-- contract if a catalog row is ever physically removed.
--
-- Idempotent-safe (IF NOT EXISTS) so a re-run is a no-op.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE pets
  ADD COLUMN IF NOT EXISTS locality_id uuid
  REFERENCES ar_localities (id) ON DELETE SET NULL;

ALTER TABLE welfare_reports
  ADD COLUMN IF NOT EXISTS locality_id uuid
  REFERENCES ar_localities (id) ON DELETE SET NULL;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS locality_id uuid
  REFERENCES ar_localities (id) ON DELETE SET NULL;

-- FK indexes. Partial on IS NOT NULL: only resolved rows carry the key, and the
-- future locality-grain rollup joins/filters on non-null values.
CREATE INDEX IF NOT EXISTS pets_locality_id_idx
  ON pets (locality_id)
  WHERE locality_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS welfare_reports_locality_id_idx
  ON welfare_reports (locality_id)
  WHERE locality_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cases_locality_id_idx
  ON cases (locality_id)
  WHERE locality_id IS NOT NULL;
