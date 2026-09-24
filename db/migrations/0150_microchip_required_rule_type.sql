-- Migration 0150 — Widen govt_business_rules CHECK constraint to include the
-- microchip applicability rule type (jurisdiction-compliance):
--   microchip_required
--
-- WHY
-- ---
-- The microchip obligation on the owner compliance panel
-- (lib/projections/pet-compliance.ts deriveMicrochip) was hardcoded-universal:
-- every pet, in every jurisdiction, saw the same "Microchip" card citing a CABA
-- ordinance. The PO's "regla de dónde fue registrada" needs microchip
-- applicability to be a per-jurisdiction rule like ppp_breed_list, so a
-- jurisdiction that does NOT mandate chipping can opt out and the obligation
-- drops out of that pet's "N de M al día" count.
--
-- This migration front-loads the DB step: it widens the CHECK so the
-- microchip_required rule type is a legal value. The TypeScript enum
-- (GOVT_BUSINESS_RULE_TYPES) adds it in the same change, along with its
-- validator, default (required: true) and registry entry.
--
-- DEFAULT-TRUE, NON-BREAKING: no rows are inserted here. With ZERO override
-- rows, resolveBusinessRule("microchip_required", ...) returns the hardcoded
-- default { required: true } for every jurisdiction, so the microchip
-- obligation keeps showing exactly as before until a jurisdiction writes a
-- { required: false } override.
--
-- SCOPE: only the CHECK constraint changes. No rows are inserted, updated, or
-- backfilled. No behavior change at rollout.
--
-- IDEMPOTENCY: DROP CONSTRAINT uses IF EXISTS; ADD CONSTRAINT is guarded by
-- a DO block that checks pg_constraint before adding. Safe to replay.
--
-- ROLLBACK: to revert, first purge any rows using the new rule type
-- (`DELETE FROM govt_business_rules WHERE rule_type = 'microchip_required'`),
-- THEN re-run migration 0120's constraint (10-value -> 9-value list). Reverting
-- with rows still present will fail the ADD CONSTRAINT step — intentional: it
-- forces an explicit, reviewed data decision before schema rollback, not a
-- silent row loss.

BEGIN;

-- Drop the existing constraint (9-value list from migration 0120).
ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

-- Re-add with the 10-value list that includes the microchip rule type.
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
        'travel_corridor_requirements'
      ));
  END IF;
END $$;

COMMIT;
