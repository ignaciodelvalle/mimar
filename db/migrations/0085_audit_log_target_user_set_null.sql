-- Migration 0085: extend audit_log trigger to allow all FK cascade nullifications
--
-- Problem
-- -------
-- Migration 0080 added ON DELETE SET NULL for audit_log.actor_user_id and
-- updated the enforce_audit_log_append_only trigger to pass through that
-- specific cascade. However, ALL nullable FK columns in audit_log reference
-- parent tables with ON DELETE SET NULL:
--
--   actor_user_id            → profiles.id
--   target_user_id           → profiles.id
--   target_organization_id   → organizations.id
--   target_govt_assignment_id → govt_assignments.id
--   approval_request_id      → approval_requests.id
--
-- The original trigger only permitted actor_user_id nullification. Any other FK
-- cascade (e.g. DELETE organizations, DELETE profiles for target_user_id) was
-- incorrectly blocked with "audit_log is append-only. UPDATE blocked."
--
-- This was discovered in ARCH-T: the new org_member_added / org_member_removed
-- / org_member_role_changed audit writes populate target_user_id and
-- target_organization_id, so test cleanup (deleteUserByEmail → DELETE profiles,
-- test teardown → DELETE organizations) started failing.
--
-- Fix
-- ---
-- Replace the per-column case logic with a general rule:
--   Allow an UPDATE iff:
--     1. The four truly immutable columns are unchanged:
--        id, action, payload, performed_at.
--     2. Every nullable FK column either stays the same OR goes from non-NULL
--        to NULL (i.e. pure cascade nullification — no re-assignment to another
--        non-NULL value).
--
-- This covers all current and future FK cascade SET NULL combinations without
-- enumerating each case explicitly.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION public.enforce_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Explicit GUC bypass: test cleanup and migrations that need direct mutation.
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Allow FK cascade nullification of any nullable FK column (ON DELETE SET NULL).
  -- The four immutable business columns must be unchanged.
  -- Each nullable FK column may only be unchanged OR nullified (non-NULL → NULL).
  -- Re-assignment to a different non-NULL value is NOT allowed.
  IF TG_OP = 'UPDATE'
    AND NEW.id           = OLD.id
    AND NEW.action       = OLD.action
    AND NEW.payload      = OLD.payload
    AND NEW.performed_at = OLD.performed_at
    -- actor_user_id: unchanged or nullified
    AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
         OR (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL))
    -- target_user_id: unchanged or nullified
    AND (NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id
         OR (OLD.target_user_id IS NOT NULL AND NEW.target_user_id IS NULL))
    -- target_organization_id: unchanged or nullified
    AND (NEW.target_organization_id IS NOT DISTINCT FROM OLD.target_organization_id
         OR (OLD.target_organization_id IS NOT NULL AND NEW.target_organization_id IS NULL))
    -- target_govt_assignment_id: unchanged or nullified
    AND (NEW.target_govt_assignment_id IS NOT DISTINCT FROM OLD.target_govt_assignment_id
         OR (OLD.target_govt_assignment_id IS NOT NULL AND NEW.target_govt_assignment_id IS NULL))
    -- approval_request_id: unchanged or nullified
    AND (NEW.approval_request_id IS NOT DISTINCT FROM OLD.approval_request_id
         OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS NULL))
    -- At least one FK column must actually be changing (otherwise it's a no-op UPDATE
    -- that shouldn't be blocked anyway, but this makes the intent explicit).
    AND (
      NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
      OR NEW.target_organization_id IS DISTINCT FROM OLD.target_organization_id
      OR NEW.target_govt_assignment_id IS DISTINCT FROM OLD.target_govt_assignment_id
      OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only. % blocked.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
