-- Welfare reports assignment column — Chunk E E4.
-- Reference: docs/superpowers/plans/2026-05-21-govt-dashboards.md §E4
-- Idempotent — safe to re-run.

ALTER TABLE welfare_reports
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS welfare_reports_assigned_to_idx
  ON welfare_reports (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;
