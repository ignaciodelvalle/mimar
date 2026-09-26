-- ────────────────────────────────────────────────────────────────────────────
-- 0263_business_rule_place_keys.sql
-- A business rule is unique by the place it names: a catalogue row, an
-- authority unit, or — for the rules that name neither (national, provincial,
-- and any legacy row) — its (country, province, locality) text.
--
-- WHY (localidades-por-id D4)
-- ---------------------------
-- govt_business_rules_type_jurisdiction_unique (0183) and its older twin
-- govt_business_rules_jurisdiction_rule_type_unique (0037) made (rule type,
-- country, province, locality NAME) unique. The rules wizard refused a
-- homonym (Mechita, partido Alberti and partido Bragado) because the name
-- could not say which one; with the wizard now writing the catalogue row
-- (locality_id) or a confirmed authority unit (authority_unit_id), the two
-- Mechitas are two places, and each may carry its own ordinance — the name
-- constraint would refuse the second.
--
--   govt_business_rules_type_locality_unique  one rule per (type, catalogue row)
--   govt_business_rules_type_unit_unique      one rule per (type, authority unit)
--   govt_business_rules_type_name_unique      one rule per (type, country,
--                                             province, locality text; NULL
--                                             coalesced to '') among the rules
--                                             keyed to neither — the 0183 rule,
--                                             unchanged for every such row
--   govt_business_rules_one_place_key         a rule names a row OR a unit,
--                                             never both (the resolver reads one)
--
-- The legal-baseline seed (scripts/seed-legal-baseline.ts) upserted on the
-- 0183 constraint by name; it now updates the row it already selected by id
-- and inserts otherwise (its rows are national or provincial: the name index).
-- Idempotent. Forward-only. Rollback: a forward migration restoring the 0183
-- constraint once no two keyed rules share a name.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- A keyed index must hold before it is created: two rules of one type on one
-- catalogue row would be a name collision the old constraint never saw.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.govt_business_rules
     WHERE locality_id IS NOT NULL
     GROUP BY rule_type, locality_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 0263: two rules of one type point at one catalogue row; resolve them first';
  END IF;
END
$$;

ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_type_jurisdiction_unique;
DROP INDEX IF EXISTS public.govt_business_rules_jurisdiction_rule_type_unique;

CREATE UNIQUE INDEX IF NOT EXISTS govt_business_rules_type_locality_unique
  ON public.govt_business_rules (rule_type, locality_id)
  WHERE locality_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS govt_business_rules_type_unit_unique
  ON public.govt_business_rules (rule_type, authority_unit_id)
  WHERE authority_unit_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS govt_business_rules_type_name_unique
  ON public.govt_business_rules (
    rule_type,
    jurisdiction_country,
    coalesce(jurisdiction_province, ''),
    coalesce(jurisdiction_locality, '')
  )
  WHERE locality_id IS NULL AND authority_unit_id IS NULL;

ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_one_place_key;
ALTER TABLE public.govt_business_rules
  ADD CONSTRAINT govt_business_rules_one_place_key
  CHECK (locality_id IS NULL OR authority_unit_id IS NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'govt_business_rules_type_jurisdiction_unique'
  ) OR EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'govt_business_rules_jurisdiction_rule_type_unique'
  ) THEN
    RAISE EXCEPTION 'Migration 0263 did not close: a name-only uniqueness is still there';
  END IF;
  IF (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'govt_business_rules'
         AND indexname IN ('govt_business_rules_type_locality_unique',
                           'govt_business_rules_type_unit_unique',
                           'govt_business_rules_type_name_unique')) <> 3 THEN
    RAISE EXCEPTION 'Migration 0263 did not close: the three partial unique indexes must exist';
  END IF;
END
$$;

COMMIT;
