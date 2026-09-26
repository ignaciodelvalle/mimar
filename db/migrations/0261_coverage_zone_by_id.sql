-- ────────────────────────────────────────────────────────────────────────────
-- 0261_coverage_zone_by_id.sql
-- A coverage zone is unique by what it names: a catalogue row, a unit, or —
-- for the zones that name neither — its (province, locality) text.
--
-- WHY (localidades-por-id D5)
-- ---------------------------
-- org_coverage_org_province_locality_unique (0073) made (organization,
-- province, locality NAME) unique. With the zone editor picking a catalogue
-- row by id, an organization working in Mechita (partido Alberti) AND Mechita
-- (partido Bragado) holds two zones with the same name — the name constraint
-- would refuse the second one, or worse, make the editor store it by name.
--
--   org_coverage_org_locality_id_unique   one zone per (org, catalogue row)
--   org_coverage_org_unit_unique          one zone per (org, authority unit)
--   org_coverage_org_name_unique          one zone per (org, province, locality
--                                         text, NULL coalesced to '') among
--                                         the zones keyed to
--                                         neither — the 0073 rule, unchanged
--                                         for every existing row
--   organization_coverage_one_key         a zone names a row OR a unit, never
--                                         both (the id path reads one key)
--
-- Existing rows are all unkeyed, so the partial name index holds exactly what
-- the old constraint held. Idempotent. Forward-only. Rollback: a forward
-- migration restoring the 0073 constraint once no two keyed zones share a
-- name.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.organization_coverage
  DROP CONSTRAINT IF EXISTS org_coverage_org_province_locality_unique;

CREATE UNIQUE INDEX IF NOT EXISTS org_coverage_org_locality_id_unique
  ON public.organization_coverage (organization_id, locality_id)
  WHERE locality_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_coverage_org_unit_unique
  ON public.organization_coverage (organization_id, authority_unit_id)
  WHERE authority_unit_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_coverage_org_name_unique
  ON public.organization_coverage (organization_id, jurisdiction_province, coalesce(jurisdiction_locality, ''))
  WHERE locality_id IS NULL AND authority_unit_id IS NULL;

ALTER TABLE public.organization_coverage
  DROP CONSTRAINT IF EXISTS organization_coverage_one_key;
ALTER TABLE public.organization_coverage
  ADD CONSTRAINT organization_coverage_one_key
  CHECK (locality_id IS NULL OR authority_unit_id IS NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_coverage_org_province_locality_unique'
  ) THEN
    RAISE EXCEPTION 'Migration 0261 did not close: the 0073 name constraint is still there';
  END IF;
  IF (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'organization_coverage'
         AND indexname IN ('org_coverage_org_locality_id_unique', 'org_coverage_org_unit_unique',
                           'org_coverage_org_name_unique')) <> 3 THEN
    RAISE EXCEPTION 'Migration 0261 did not close: the three partial unique indexes must exist';
  END IF;
END
$$;

COMMIT;
