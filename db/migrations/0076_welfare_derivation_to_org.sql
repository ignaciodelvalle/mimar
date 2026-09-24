-- Migration 0076: welfare report derivation to org
--
-- Adds three nullable columns to welfare_reports so a govt/admin actor can
-- forward a report to a verified shelter or rescue_network for follow-up:
--
--   derived_to_organization_id  FK → organizations.id (SET NULL on delete)
--   derived_at                  timestamp with time zone
--   derived_by_user_id          FK → profiles.id (SET NULL on delete)
--
-- The derived_to_organization_id column drives the new org-side inbox at
-- /org/[orgToken]/maltrato/recibidos?tab=recibidos.
--
-- An index on derived_to_organization_id keeps the inbox query efficient.

ALTER TABLE welfare_reports
  ADD COLUMN IF NOT EXISTS derived_to_organization_id uuid
    REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS derived_at timestamptz,
  ADD COLUMN IF NOT EXISTS derived_by_user_id uuid
    REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS welfare_reports_derived_to_org_idx
  ON welfare_reports (derived_to_organization_id);
