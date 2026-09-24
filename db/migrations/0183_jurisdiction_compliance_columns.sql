-- Migration 0183 — Jurisdiction-aware compliance (rules-engine v2, WU1):
-- requirement tier + legal provenance columns on govt_business_rules, three
-- new rule types, and the uniqueness constraint the baseline seed upserts on.
--
-- WHY
-- ---
-- The compliance surface answers "what does the law where THIS pet lives
-- require?" but govt_business_rules rows only carry an untyped payload — no
-- requirement tier (mandatory vs recommended vs not regulated), no legal
-- citation, no authority, no effective dates. This migration adds that
-- dimension as ADDITIVE nullable columns so every existing row and reader
-- keeps working unchanged (spec RM1-RM4, design ADR-1).
--
-- Three new rule types widen the CHECK (spec OR1, ADR-2/ADR-8):
--   rabies_vaccination  — per-pet rabies vaccination obligation tier
--   sterilization       — per-pet sterilization obligation tier
--   compliance_targets  — per-jurisdiction metric targets (partial record)
-- Microchip obligation is NOT a new type: the existing microchip_required
-- type gains the tier via requirement_level (a parallel type could disagree
-- with the row consumers already resolve).
--
-- ZERO BEHAVIOR DIFF AT ROLLOUT: no rows are seeded here; requirement_level
-- backfills only restate what each existing row already meant (see BACKFILL
-- below); consumers keep their boolean fallback until a tier is set.
--
-- CHECK constraints are added NOT VALID then VALIDATE (hot, RLS-protected,
-- audited table — validation scans without blocking writes).
--
-- UNIQUE (rule_type, country, province, locality) NULLS NOT DISTINCT: the
-- application writer already rejects duplicates (create-business-rule.ts);
-- this makes the invariant a DB fact and gives scripts/seed-legal-baseline.ts
-- (WU2) its ON CONFLICT target. NULLS NOT DISTINCT so country-level rows
-- (province/locality NULL) deduplicate too — same pattern as migration 0073.
--
-- BACKFILL (per-type, never blanket — spec RM4):
--   microchip_required: payload.required=true -> mandatory, false -> not_regulated
--   ppp_breed_list: configured (non-empty breeds) -> mandatory, else not_regulated
--   ppp_weight_threshold: configured (kg set) -> mandatory, else not_regulated
--   ppp_attestation_required_registries: >=1 required registry -> mandatory,
--     else not_regulated
--   operational-window types (rabies_observation_window, due_soon_window,
--   reminder_windows, long_stay_days, travel_corridor_requirements,
--   mpf_export_format, physical_credential_channels): stay NULL — the
--   mandatory/recommended dimension does not apply to them.
--
-- IDEMPOTENCY: ADD COLUMN IF NOT EXISTS; constraint adds guarded by
-- pg_constraint lookups; backfill UPDATEs filter on requirement_level IS NULL.
-- Safe to replay.
--
-- ROLLBACK: drop the three new columns' consumers first (application code),
-- then: purge rows using the three new rule types, re-run migration 0156's
-- 11-value CHECK, drop the new columns and the unique constraint. Reverting
-- with rows present fails the ADD CONSTRAINT step — intentional: forces an
-- explicit data decision, not silent row loss.

BEGIN;

-- 1. Additive nullable columns -------------------------------------------------

ALTER TABLE public.govt_business_rules
  ADD COLUMN IF NOT EXISTS requirement_level text,
  ADD COLUMN IF NOT EXISTS legal_basis text,
  ADD COLUMN IF NOT EXISTS authority text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_until date,
  ADD COLUMN IF NOT EXISTS baseline_version text;

-- 2. requirement_level CHECK (NOT VALID -> VALIDATE) ---------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'govt_business_rules'
      AND  c.conname = 'govt_business_rules_requirement_level_valid'
  ) THEN
    ALTER TABLE public.govt_business_rules
      ADD CONSTRAINT govt_business_rules_requirement_level_valid
      CHECK (requirement_level IS NULL OR requirement_level IN (
        'mandatory',
        'recommended',
        'not_regulated',
        'optional'
      )) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.govt_business_rules
  VALIDATE CONSTRAINT govt_business_rules_requirement_level_valid;

-- 3. Widen rule_type CHECK: 11 -> 14 values ------------------------------------
-- List copied VERBATIM from the live constraint (migration 0156 /
-- db/schema.ts) — includes travel_corridor_requirements, which is legal in
-- the DB CHECK but absent from the GOVT_BUSINESS_RULE_TYPES TS enum
-- (migration-errata: do not infer this list from the enum).

ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'govt_business_rules'
      AND  c.conname = 'govt_business_rules_rule_type_valid'
  ) THEN
    ALTER TABLE public.govt_business_rules
      ADD CONSTRAINT govt_business_rules_rule_type_valid
      CHECK (rule_type IN (
        'ppp_breed_list',
        'ppp_weight_threshold',
        'ppp_attestation_required_registries',
        'physical_credential_channels',
        'microchip_required',
        'rabies_observation_window',
        'due_soon_window',
        'reminder_windows',
        'long_stay_days',
        'travel_corridor_requirements',
        'mpf_export_format',
        'rabies_vaccination',
        'sterilization',
        'compliance_targets'
      )) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.govt_business_rules
  VALIDATE CONSTRAINT govt_business_rules_rule_type_valid;

-- 4. Uniqueness: one row per (rule_type, jurisdiction tuple) -------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'govt_business_rules'
      AND  c.conname = 'govt_business_rules_type_jurisdiction_unique'
  ) THEN
    ALTER TABLE public.govt_business_rules
      ADD CONSTRAINT govt_business_rules_type_jurisdiction_unique
      UNIQUE NULLS NOT DISTINCT (
        rule_type,
        jurisdiction_country,
        jurisdiction_province,
        jurisdiction_locality
      );
  END IF;
END $$;

-- 5. Backfill requirement_level from existing data (per-type, never blanket) ---

UPDATE public.govt_business_rules
SET    requirement_level = CASE
         WHEN COALESCE((rule_payload ->> 'required')::boolean, true)
           THEN 'mandatory'
         ELSE 'not_regulated'
       END
WHERE  rule_type = 'microchip_required'
  AND  requirement_level IS NULL;

UPDATE public.govt_business_rules
SET    requirement_level = CASE
         WHEN COALESCE(jsonb_array_length(rule_payload -> 'breeds'), 0) > 0
           THEN 'mandatory'
         ELSE 'not_regulated'
       END
WHERE  rule_type = 'ppp_breed_list'
  AND  requirement_level IS NULL;

UPDATE public.govt_business_rules
SET    requirement_level = CASE
         WHEN rule_payload ->> 'kg' IS NOT NULL THEN 'mandatory'
         ELSE 'not_regulated'
       END
WHERE  rule_type = 'ppp_weight_threshold'
  AND  requirement_level IS NULL;

UPDATE public.govt_business_rules
SET    requirement_level = CASE
         WHEN EXISTS (
           SELECT 1
           FROM   jsonb_array_elements(rule_payload -> 'registries') AS reg
           WHERE  COALESCE((reg ->> 'required')::boolean, false)
         ) THEN 'mandatory'
         ELSE 'not_regulated'
       END
WHERE  rule_type = 'ppp_attestation_required_registries'
  AND  requirement_level IS NULL;

COMMIT;
