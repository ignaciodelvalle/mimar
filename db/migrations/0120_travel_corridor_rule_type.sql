-- Migration 0120 — Widen govt_business_rules CHECK constraint to include the
-- travel corridor rule type (movilidad-jurisdiccional Fase 1, design D4):
--   travel_corridor_requirements
--
-- Fase 1 corridor data is CODE-FIRST (lib/reference/cross-border-corridors.ts,
-- spec R3.1) — govt_business_rules gets ZERO corridor rows at rollout. This
-- migration ONLY front-loads the DB step of the future promotion path (Fork 3:
-- country-desk overrides): migrations are owner-gated, so widening the CHECK
-- now means the later app-side promotion is pure code. The TypeScript enum
-- (GOVT_BUSINESS_RULE_TYPES) deliberately does NOT include this type yet —
-- a permissive CHECK value with no writer is harmless and unused.
--
-- SCOPE: only the CHECK constraint changes. No rows are inserted, updated, or
-- backfilled. No behavior change at rollout.
--
-- IDEMPOTENCY: DROP CONSTRAINT uses IF EXISTS; ADD CONSTRAINT is guarded by
-- a DO block that checks pg_constraint before adding. Safe to replay.
--
-- ROLLBACK: to revert, first purge any rows using the new rule type
-- (`DELETE FROM govt_business_rules WHERE rule_type =
-- 'travel_corridor_requirements'`), THEN re-run migration 0116's constraint
-- (9-value -> 8-value list). Reverting with rows still present will fail the
-- ADD CONSTRAINT step — intentional: it forces an explicit, reviewed data
-- decision before schema rollback, not a silent row loss.

BEGIN;

-- Drop the existing constraint (8-value list from migration 0116).
ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

-- Re-add with the 9-value list that includes the travel corridor rule type.
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
        'long_stay_days',
        'travel_corridor_requirements'
      ));
  END IF;
END $$;

COMMIT;
