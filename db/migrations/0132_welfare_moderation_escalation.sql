-- Welfare moderation: govt-to-admin escalation columns.
--
-- Phase 2 of jurisdiction-scoped denuncia moderation (SDD
-- docs/design/handoffs/2026-07-07-govt-jurisdiction-moderation-sdd.md).
--
-- A jurisdiction govt can escalate a flagged anonymous denuncia back to the
-- national admin queue instead of approving or rejecting it (cross-jurisdiction,
-- ambiguous, or "not my call" reports). Escalation is an append-only decision:
-- the report is NOT resolved (moderation_resolved_at stays NULL, so it remains
-- in the admin queue) but it leaves the govt's actionable queue. The audit_log
-- row (welfare_report_escalated_to_admin) carries the motivo.
--
-- Forward-only, immutable.

ALTER TABLE welfare_reports
  ADD COLUMN moderation_escalated_at timestamptz,
  ADD COLUMN moderation_escalated_by_user_id uuid
    REFERENCES profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN welfare_reports.moderation_escalated_at IS
  'When a jurisdiction govt escalated this flagged denuncia to the national admin queue. NULL = not escalated. The row stays moderation-pending (admin still owns it); it only leaves the govt actionable queue.';
COMMENT ON COLUMN welfare_reports.moderation_escalated_by_user_id IS
  'Govt/admin user who escalated the flagged denuncia to admin. Motivo lives in the welfare_report_escalated_to_admin audit_log row.';
