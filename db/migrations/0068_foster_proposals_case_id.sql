-- Migration 0068: add case_id to foster_proposals
-- Links each foster_proposal row to the cases row opened atomically
-- by proposeFosterAction. Nullable so existing rows survive without backfill.

ALTER TABLE foster_proposals
  ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES cases(id) ON DELETE SET NULL;

-- Index to speed up the close-on-resolve path: given a proposal id, look up
-- its case_id without a full table scan.
CREATE INDEX IF NOT EXISTS foster_proposals_case_id_idx ON foster_proposals (case_id)
  WHERE case_id IS NOT NULL;
