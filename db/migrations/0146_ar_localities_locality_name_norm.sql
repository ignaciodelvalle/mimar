-- ────────────────────────────────────────────────────────────────────────────
-- 0146_ar_localities_locality_name_norm.sql
-- Sargable normalized-locality-name column + index on ar_localities.
--
-- WHY
-- ---
-- The panorama choropleth loaders join a source table (pets / welfare_reports /
-- pet_events payloads) to ar_localities to resolve a locality CENTROID and its
-- INDEC department. The join key is a normalized locality NAME, computed at
-- query time by normNameSql() (src/modules/panorama/infrastructure/repository.ts):
--
--   btrim(regexp_replace(lower(translate(unaccent(locality_name), '.', '')),
--                        '\s+', ' ', 'g'))
--
-- Applying that expression to BOTH sides of the join makes the equality
-- NON-SARGABLE: Postgres cannot use any index on ar_localities, so for the
-- Buenos Aires province drill (most dogs × biggest partition) the planner
-- nested-loops the whole ar_localities table for every candidate pet — millions
-- of unaccent()/regexp evaluations, ~15-20s per load, past the 8s DB budget.
--
-- WHAT
-- ----
-- Materialize the ar_localities side of that expression as a STORED generated
-- column and index (province_code, locality_name_norm). The join can then be
-- rewritten to compare the indexed column against the (still runtime-normalized)
-- source-table value — a sargable equality the planner resolves with an index
-- scan. The value is byte-identical to normNameSql(locality_name), so the join
-- semantics are unchanged; only the plan improves.
--
-- IMMUTABILITY
-- ------------
-- A STORED generated column expression must be IMMUTABLE, but the built-in
-- unaccent() is only STABLE (it looks up the default text-search dictionary at
-- run time). The standard workaround is an IMMUTABLE SQL wrapper that pins the
-- dictionary explicitly (two-arg form). unaccent is installed in the `public`
-- schema locally and on staging/prod; the wrapper and the generated expression
-- schema-qualify every reference so the stored value never depends on
-- search_path.
--
-- Backfill is implicit: a STORED generated column is populated for every
-- existing row when the column is added.
--
-- Idempotent-safe (IF NOT EXISTS / CREATE OR REPLACE) so a re-run is a no-op.
-- ────────────────────────────────────────────────────────────────────────────

-- IMMUTABLE unaccent wrapper — pins the dictionary explicitly so the generated
-- column expression is provably immutable and independent of search_path.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $func$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $func$;

-- Stored normalized locality name — materializes normNameSql(locality_name)
-- exactly (immutable_unaccent produces the same text as the STABLE unaccent).
ALTER TABLE ar_localities
  ADD COLUMN IF NOT EXISTS locality_name_norm text
  GENERATED ALWAYS AS (
    btrim(regexp_replace(
      lower(translate(public.immutable_unaccent(locality_name), '.', '')),
      '\s+', ' ', 'g'))
  ) STORED;

-- Sargable lookup index for the panorama centroid joins. Partial on the same
-- predicate every join already carries (removed_at IS NULL), leading with
-- province_code so the (province, normalized-name) equality is an index scan.
CREATE INDEX IF NOT EXISTS ar_localities_province_locality_norm_idx
  ON ar_localities (province_code, locality_name_norm)
  WHERE removed_at IS NULL;
