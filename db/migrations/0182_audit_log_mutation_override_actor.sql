-- Migration 0182: audit_log GUC bypass requires an accountable actor + self-logs
--
-- Problem
-- -------
-- enforce_audit_log_append_only() (current body: 0085) honors
-- app.allow_audit_mutation = 'true' as an UNCONDITIONAL bypass: any UPDATE/
-- DELETE on audit_log proceeds silently, with zero trace of who did it. This
-- was the one override class on this table that left no accountability —
-- contrast with pet_events / case_events (db/triggers.sql
-- enforce_pet_events_append_only / enforce_case_events_append_only), whose
-- override hatches both REQUIRE app.allow_event_mutation_actor (a uuid) and
-- self-log the override before proceeding.
--
-- Fix
-- ---
-- Mirror that hatch for the GUC-bypass branch ONLY:
--   1. Require app.allow_audit_mutation_actor (uuid) in the same session.
--      Missing/invalid -> RAISE EXCEPTION (refused, never silently granted).
--   2. INSERT one audit_log row (action = 'audit_log_mutation_override')
--      before returning, attributed to the actor. The INSERT is unaffected by
--      this trigger itself: it fires BEFORE UPDATE OR DELETE only, never
--      BEFORE INSERT (db/migrations/0010_admin_fase_0.sql).
--
-- The FK-cascade-nullification branch (0085, reproduced unchanged below)
-- still requires NO actor — ON DELETE SET NULL cascades never carry an
-- app-level actor and must keep working exactly as today.
--
-- This CREATE OR REPLACE also folds 0114's `ALTER FUNCTION ... SET
-- search_path = ''` directly into the definition, closing the exact
-- body-vs-config split that produced errata E-3 (docs/db/migration-errata.md):
-- a future body replace can no longer drop the search_path pin by touching
-- only the body.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION public.enforce_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  override_actor uuid;
BEGIN
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    override_actor := nullif(current_setting('app.allow_audit_mutation_actor', true), '')::uuid;
    IF override_actor IS NULL THEN
      RAISE EXCEPTION 'audit_log mutation override requires app.allow_audit_mutation_actor (uuid) to be set in the same session'
        USING ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO public.audit_log (actor_user_id, action, payload)
    VALUES (
      override_actor,
      'audit_log_mutation_override',
      jsonb_build_object(
        'operation',     TG_OP,
        'audit_log_id',  COALESCE(NEW.id, OLD.id),
        'target_action', COALESCE(NEW.action, OLD.action),
        'performed_at',  COALESCE(NEW.performed_at, OLD.performed_at)
      )
    );

    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Allow FK cascade nullification of any nullable FK column (ON DELETE SET
  -- NULL) — UNCHANGED from 0085's body.
  IF TG_OP = 'UPDATE'
    AND NEW.id           = OLD.id
    AND NEW.action       = OLD.action
    AND NEW.payload      = OLD.payload
    AND NEW.performed_at = OLD.performed_at
    AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
         OR (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL))
    AND (NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id
         OR (OLD.target_user_id IS NOT NULL AND NEW.target_user_id IS NULL))
    AND (NEW.target_organization_id IS NOT DISTINCT FROM OLD.target_organization_id
         OR (OLD.target_organization_id IS NOT NULL AND NEW.target_organization_id IS NULL))
    AND (NEW.target_govt_assignment_id IS NOT DISTINCT FROM OLD.target_govt_assignment_id
         OR (OLD.target_govt_assignment_id IS NOT NULL AND NEW.target_govt_assignment_id IS NULL))
    AND (NEW.approval_request_id IS NOT DISTINCT FROM OLD.approval_request_id
         OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS NULL))
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
