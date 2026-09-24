-- Migration 0092: org intervention state on derived welfare reports (UI-7)
--
-- An org that received a derived welfare report (derived_to_organization_id set)
-- can now act on it WITHOUT closing it (gov remains the only closer):
--
--   - mark it "tomado" (taken / under intervention)
--   - return it "devuelto" (cannot intervene), with a reason captured as a
--     case_events note (entry_type='org_intervention_return')
--
-- State representation:
--   org_intervention_status  text — NULL (no org action yet) | 'tomado' | 'devuelto'
--   org_intervention_at      timestamptz — when the last org transition happened
--
-- Both columns are NON-PII (workflow metadata, no reporter identity) so the
-- org-facing projection (ORG_WELFARE_SELECT) may read them. A CHECK constrains
-- the status to the two known values (or NULL).
--
-- On "devuelto" the action ALSO nulls derived_to_organization_id so the report
-- reappears actionable in the gov derivation panel; org_intervention_status
-- stays 'devuelto' (sticky) and the return reason lives in a case_events note,
-- which the gov derivation panel surfaces as "devuelto por la org: <reason>".

ALTER TABLE welfare_reports
  ADD COLUMN IF NOT EXISTS org_intervention_status text,
  ADD COLUMN IF NOT EXISTS org_intervention_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'welfare_reports_org_intervention_status_check'
  ) THEN
    ALTER TABLE welfare_reports
      ADD CONSTRAINT welfare_reports_org_intervention_status_check
      CHECK (org_intervention_status IS NULL OR org_intervention_status IN ('tomado', 'devuelto'));
  END IF;
END$$;
