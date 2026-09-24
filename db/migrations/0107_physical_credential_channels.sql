-- Migration 0107 — Widen govt_business_rules CHECK constraint to include
-- 'physical_credential_channels'.
-- Phase A of the physical credential hub (plan 2026-06-19-physical-credential-hub).
--
-- The TypeScript enum (GOVT_BUSINESS_RULE_TYPES in db/schema.ts) already
-- contains 'physical_credential_channels' since Phase A. This migration syncs
-- the live Postgres CHECK constraint so that DB inserts of the new rule type
-- are accepted.
--
-- SCOPE: this migration ONLY updates the CHECK constraint. It does NOT add
-- physical_tag_interest.channel (that is Phase C).
--
-- IDEMPOTENCY: DROP CONSTRAINT uses IF EXISTS; ADD CONSTRAINT is guarded by
-- a DO block that checks pg_constraint before adding. Safe to replay.

BEGIN;

-- Drop the existing constraint (3-value list from migration 0037).
ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

-- Re-add with the 4-value list that includes 'physical_credential_channels'.
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
        'physical_credential_channels'
      ));
  END IF;
END $$;

COMMIT;
