-- Migration 0075: solo-consultorio auto-verify bridge (D1 + D4)
--
-- Two changes:
--
-- 1. organizations.auto_verified_via_matricula (boolean NOT NULL DEFAULT false)
--    Marks clinic orgs that were auto-verified at creation because their sole
--    admin held a verified personal matrícula (D1). Used by the revocation
--    cascade (D4) to un-verify ONLY matrícula-derived verifications — never
--    institutionally-reviewed ones.
--
-- 2. Relax approval_requests.approval_decision_consistent CHECK constraint
--    to allow decidedByUserId = NULL for system-automated decisions (e.g.
--    auto-verify). The original constraint required decidedByUserId IS NOT NULL
--    for approved/rejected rows. The new rule: decidedAt IS NOT NULL is still
--    required, but decidedByUserId may be null (audit trail carried by the
--    autoVerifiedViaMatricula flag and decisionNotes instead).

-- Step 1: add the new column to organizations.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_verified_via_matricula boolean NOT NULL DEFAULT false;

-- Step 2: relax the CHECK constraint on approval_requests.
-- The original name is approval_decision_consistent (declared in the schema and
-- in migrations 0015/0017 — confirmed by inspecting those files).
ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_decision_consistent;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_decision_consistent CHECK (
    (status IN ('approved', 'rejected') AND decided_at IS NOT NULL)
    OR (status IN ('pending', 'withdrawn') AND decided_at IS NULL AND decided_by_user_id IS NULL)
  );
