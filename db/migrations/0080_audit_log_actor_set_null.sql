-- Migration 0080: RESTRICT → SET NULL for actor-trace FKs to profiles.id (ARCH-H P1)
--
-- Scope
-- -----
-- Two tables have FKs to profiles.id that would block a hard-delete of a user
-- profile. Both carry actor-trace semantics (who performed an action / who
-- created a record) — the row must outlive its author, so RESTRICT is the wrong
-- policy. This migration converts both to SET NULL.
--
-- Complete hard-delete-blocker survey (profiles.id, RESTRICT FKs):
--   1. audit_log.actor_user_id                    — RESTRICT → SET NULL (below)
--   2. govt_business_rules.created_by_user_id     — RESTRICT → SET NULL (below)
--   3. govt_business_rules.updated_by_user_id     — RESTRICT → SET NULL (below)
--
-- No other RESTRICT FKs to profiles.id exist in the schema. All remaining FKs
-- from other tables to profiles.id use CASCADE or SET NULL, which are
-- intentional (active user relationships where deleting the profile should
-- cascade to the dependent row, or nullable optional references).
--
-- ============================================================================
-- TABLE 1: audit_log.actor_user_id
-- ============================================================================
--
-- Problem
-- -------
-- audit_log.actor_user_id has ON DELETE RESTRICT to profiles.id. The subject-
-- rights erase_subject_data() RPC (migration 0059, Ley 25.326 art. 16) performs
-- a soft-delete (sets deleted_at / hashes PII) but never hard-deletes the
-- profile row. RESTRICT makes any eventual hard-deletion of the profile
-- impossible without first removing audit_log rows, which would destroy the
-- audit trail — a compliance contradiction.
--
-- Decision
-- --------
-- Change to ON DELETE SET NULL. The audit row must survive a hard user-delete
-- intact (action, payload, timestamps, target_user_id are all preserved). The
-- actor FK becomes NULL, displayed as "Usuario eliminado" in the audit UI.
--
-- Audit value is not lost: every INSERT into audit_log records the action type
-- and a structured payload capturing the business context (reason, norma,
-- self_erasure, etc.). The actor UUID is redundant for compliance purposes once
-- the profile is erased — the payload already captures who authorized the action
-- at record time. All other audit columns are unaffected.
--
-- actor_user_id also becomes nullable (DROP NOT NULL). Existing rows are not
-- touched — all current actor_user_id values are non-null.
--
-- Trigger update
-- --------------
-- The existing enforce_audit_log_append_only trigger blocks all UPDATEs to
-- audit_log unless app.allow_audit_mutation='true'. ON DELETE SET NULL works
-- by issuing an UPDATE (actor_user_id → NULL) on the child rows when the
-- referenced profile is deleted — this would be blocked by the trigger.
--
-- We extend the trigger function to also pass through FK nullification updates:
-- updates where the only change is actor_user_id going from non-null to null
-- (i.e. the FK cascade path). All other immutable business fields (id, action,
-- payload, performed_at, target_user_id, approval_request_id,
-- target_organization_id, target_govt_assignment_id) must be unchanged.
--
-- The actorIdx index (actor_user_id, performed_at) remains valid; Postgres
-- handles NULL values in composite indexes.
--
-- ============================================================================
-- TABLE 2: govt_business_rules.created_by_user_id / updated_by_user_id
-- ============================================================================
--
-- Problem
-- -------
-- Both columns reference profiles.id with ON DELETE RESTRICT. A govt_business_rules
-- row records who authored and last-modified a jurisdiction rule — actor-trace
-- semantics identical to audit_log. The rule must outlive its author; RESTRICT
-- would block hard-deletion of the admin profile that created or last edited it.
--
-- Decision
-- --------
-- Change both to ON DELETE SET NULL. The rule row is preserved intact. NULL
-- actors are displayed as "Usuario eliminado" in the admin UI (same fallback
-- pattern as the audit UI). No trigger guards govern govt_business_rules UPDATEs,
-- so no trigger passthrough is needed here.
--
-- Idempotent — safe to re-run.

-- 1. Update the trigger function to allow FK cascade nullifications.
CREATE OR REPLACE FUNCTION public.enforce_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Explicit GUC bypass: test cleanup and migrations that need direct mutation.
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Allow FK cascade nullification of actor_user_id (ON DELETE SET NULL).
  -- Detect: UPDATE where only actor_user_id changed, from non-null to null,
  -- and all immutable business columns are untouched.
  IF TG_OP = 'UPDATE'
    AND NEW.id                       = OLD.id
    AND NEW.action                   = OLD.action
    AND NEW.payload                  = OLD.payload
    AND NEW.performed_at             = OLD.performed_at
    AND NEW.approval_request_id      IS NOT DISTINCT FROM OLD.approval_request_id
    AND NEW.target_user_id           IS NOT DISTINCT FROM OLD.target_user_id
    AND NEW.target_organization_id   IS NOT DISTINCT FROM OLD.target_organization_id
    AND NEW.target_govt_assignment_id IS NOT DISTINCT FROM OLD.target_govt_assignment_id
    AND OLD.actor_user_id IS NOT NULL
    AND NEW.actor_user_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only. % blocked.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 2. Drop the existing RESTRICT FK.
DO $$ BEGIN
  ALTER TABLE public.audit_log
    DROP CONSTRAINT IF EXISTS audit_log_actor_user_id_profiles_id_fk;
END $$;

-- 3. Drop NOT NULL constraint on actor_user_id.
ALTER TABLE public.audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

-- 4. Re-add FK with ON DELETE SET NULL.
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_actor_user_id_profiles_id_fk
    FOREIGN KEY (actor_user_id)
    REFERENCES public.profiles(id)
    ON DELETE SET NULL;

-- ============================================================================
-- govt_business_rules: created_by_user_id and updated_by_user_id
-- ============================================================================

-- 5. Drop existing RESTRICT FKs (use IF EXISTS for idempotency).
DO $$ BEGIN
  ALTER TABLE public.govt_business_rules
    DROP CONSTRAINT IF EXISTS govt_business_rules_created_by_user_id_profiles_id_fk;
END $$;
DO $$ BEGIN
  ALTER TABLE public.govt_business_rules
    DROP CONSTRAINT IF EXISTS govt_business_rules_updated_by_user_id_profiles_id_fk;
END $$;

-- 6. Drop NOT NULL on created_by_user_id (was NOT NULL with RESTRICT).
ALTER TABLE public.govt_business_rules
  ALTER COLUMN created_by_user_id DROP NOT NULL;

-- 7. Re-add both FKs with ON DELETE SET NULL.
ALTER TABLE public.govt_business_rules
  ADD CONSTRAINT govt_business_rules_created_by_user_id_profiles_id_fk
    FOREIGN KEY (created_by_user_id)
    REFERENCES public.profiles(id)
    ON DELETE SET NULL;

ALTER TABLE public.govt_business_rules
  ADD CONSTRAINT govt_business_rules_updated_by_user_id_profiles_id_fk
    FOREIGN KEY (updated_by_user_id)
    REFERENCES public.profiles(id)
    ON DELETE SET NULL;
