-- Migration 0116 — Widen govt_business_rules CHECK constraint to include the
-- 4 promoted rule types (admin-rules-console, design ADR-4, spec domain 4):
--   rabies_observation_window, due_soon_window, reminder_windows, long_stay_days
--
-- The TypeScript enum (GOVT_BUSINESS_RULE_TYPES in db/schema.ts) already
-- contains these 4 types. This migration syncs the live Postgres CHECK
-- constraint so that DB inserts of the new rule types are accepted.
--
-- SCOPE: this migration ONLY updates the CHECK constraint. It does NOT
-- backfill any rows — every jurisdiction starts with zero overrides for the
-- 4 new types, so resolveBusinessRule falls back to the hardcoded default
-- (10 / 30 / 14 / 60 respectively — R4.2, identical to the pre-migration
-- literal constants). No behavior change at rollout.
--
-- IDEMPOTENCY: DROP CONSTRAINT uses IF EXISTS; ADD CONSTRAINT is guarded by
-- a DO block that checks pg_constraint before adding. Safe to replay.
--
-- ROLLBACK: to revert, first purge any rows using the 4 new rule types
-- (`DELETE FROM govt_business_rules WHERE rule_type IN
-- ('rabies_observation_window', 'due_soon_window', 'reminder_windows',
-- 'long_stay_days')`), THEN re-run migration 0107's constraint (8-value ->
-- 4-value list). Reverting with rows still present will fail the ADD
-- CONSTRAINT step (existing rows would violate the narrower check) — this is
-- intentional: it forces an explicit, reviewed data decision before schema
-- rollback, not a silent row loss.

BEGIN;

-- Drop the existing constraint (4-value list from migration 0107).
ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

-- Re-add with the 8-value list that includes the 4 promoted rule types.
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
        'rabies_observation_window',
        'due_soon_window',
        'reminder_windows',
        'long_stay_days'
      ));
  END IF;
END $$;

COMMIT;
