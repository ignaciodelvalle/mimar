-- Migration 0156 — Widen govt_business_rules CHECK constraint to include the
-- MPF (fiscalía) export format rule type (jurisdiction-compliance,
-- 2026-07-22 "MPF export format cascade"):
--   mpf_export_format
--
-- WHY
-- ---
-- The welfare denuncia export to fiscalía (lib/analytics/welfare-exports.ts,
-- app/gob/maltrato/[id]/MpfExportButton.tsx) was gated to CABA only
-- (lib/domain/mpf-jurisdiction.ts, MPF_CONFIGURED_PROVINCES = {"CABA"}) — a
-- rollout artifact, not a real per-province integration difference: the PDF
-- is a free-form Ley 14.346 document (decision F-D1) that works for any
-- Argentine jurisdiction. The PO decision: every jurisdiction can export;
-- the FORMAT is a per-jurisdiction rule that cascades locality > province >
-- country > national default, resolved the same way every other
-- govt_business_rules type is (resolveBusinessRule). This migration widens
-- the CHECK so mpf_export_format is a legal rule_type value. The TypeScript
-- enum (GOVT_BUSINESS_RULE_TYPES), its validator, default, and registry
-- entry ship in the same change.
--
-- DEFAULT-ONLY FORMAT TODAY: the enum ships with exactly one legal value,
-- "estandar_nacional" — the PDF the codebase already renders. No fictional
-- second fiscalía format is introduced; the cascade mechanism is real (any
-- future format variant plugs into the same resolver + form), but until a
-- second format actually exists, every jurisdiction resolves to the same
-- national default. See lib/domain/business-rules-defaults.ts.
--
-- SCOPE: only the CHECK constraint changes. No rows are inserted, updated, or
-- backfilled. The CABA-only export gate is removed in application code
-- (same change) — with ZERO override rows, resolveBusinessRule always
-- returns { format: "estandar_nacional" } (source: "default"), which is
-- exactly the PDF every jurisdiction already got when CABA-gated (no
-- behavior change to the CONTENT of the export — only the gate that blocked
-- non-CABA jurisdictions from generating it at all is removed).
--
-- IDEMPOTENCY: DROP CONSTRAINT uses IF EXISTS; ADD CONSTRAINT is guarded by
-- a DO block that checks pg_constraint before adding. Safe to replay.
--
-- ROLLBACK: to revert, first purge any rows using the new rule type
-- (`DELETE FROM govt_business_rules WHERE rule_type = 'mpf_export_format'`),
-- THEN re-run migration 0150's constraint (10-value list, before
-- travel_corridor_requirements/mpf_export_format). Reverting with rows still
-- present will fail the ADD CONSTRAINT step — intentional: it forces an
-- explicit, reviewed data decision before schema rollback, not a silent row
-- loss.

BEGIN;

-- Drop the existing constraint (11-value list from migration 0150, which
-- already included travel_corridor_requirements).
ALTER TABLE public.govt_business_rules
  DROP CONSTRAINT IF EXISTS govt_business_rules_rule_type_valid;

-- Re-add with the 12-value list that includes the MPF export format rule type.
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
        'mpf_export_format'
      ));
  END IF;
END $$;

COMMIT;
