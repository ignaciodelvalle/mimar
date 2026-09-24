-- Migration 0104 — Scan-events retention: narrow trigger exception for scanner purge.
--
-- Context (AGENTS.md §Event sourcing):
--   pet_events is append-only.  The enforce_pet_events_append_only() trigger refuses
--   all DELETE/UPDATE unless the session sets BOTH GUCs:
--     app.allow_event_mutation       = 'true'
--     app.allow_event_mutation_actor = '<actor-uuid>'
--
-- Wave 5 Item 28 adds a privacy-retention cron that purges credential_scanned events
-- authored by the 'scanner' role that are older than 90 days (TTL approved by owner).
-- The cron runs as service-role; it MUST honour the append-only contract.
--
-- This migration adds a SECOND narrow exception path to the trigger:
--   "allow DELETE on scanner-authored events older than SCAN_RETENTION_DAYS days
--    when the session flag app.allow_scan_purge = 'true' is set."
--
-- SCOPE CONSTRAINTS (by design — do not widen):
--   - Applies only to DELETE (not UPDATE).
--   - Applies only when event_type = 'credential_scanned' AND author_role = 'scanner'.
--   - Applies only when occurred_at is older than the retention window.
--   - Requires app.allow_scan_purge = 'true' in the session.
--   - Writes an audit_log row (action = 'scan_event_purged') per deleted row so
--     the purge is traceable.  The actor is the cron service account (system actor
--     resolved from a designated system-cron profile).
--
-- Why a GUC instead of re-using allow_event_mutation:
--   allow_event_mutation is the general escape hatch with an actor accountability
--   requirement.  Re-using it for bulk purge would let any caller with that GUC
--   delete scanner events.  A dedicated, narrower GUC limits the blast radius and
--   makes audit queries unambiguous.
--
-- Idempotent — safe to re-run.

create or replace function public.enforce_pet_events_append_only()
returns trigger
language plpgsql
as $$
declare
  override_actor uuid;
  retention_days int := 90;
begin
  -- -------------------------------------------------------------------------
  -- Path 1: general mutation escape hatch (pre-existing; unchanged).
  -- Requires both app.allow_event_mutation AND app.allow_event_mutation_actor.
  -- -------------------------------------------------------------------------
  if current_setting('app.allow_event_mutation', true) = 'true' then
    override_actor := nullif(current_setting('app.allow_event_mutation_actor', true), '')::uuid;
    if override_actor is null then
      raise exception
        'pet_events mutation override requires app.allow_event_mutation_actor (uuid) to be set in the same session'
        using errcode = 'restrict_violation';
    end if;

    insert into public.audit_log (actor_user_id, action, payload)
    values (
      override_actor,
      'pet_events_mutation_override',
      jsonb_build_object(
        'operation',    tg_op,
        'pet_event_id', coalesce(new.id,          old.id),
        'pet_id',       coalesce(new.pet_id,      old.pet_id),
        'event_type',   coalesce(new.event_type,  old.event_type),
        'occurred_at',  coalesce(new.occurred_at, old.occurred_at)
      )
    );

    return coalesce(new, old);
  end if;

  -- -------------------------------------------------------------------------
  -- Path 2: narrow scan-purge exception (new — Wave 5 Item 28).
  -- DELETE only; scanner events only; older than retention window only.
  -- -------------------------------------------------------------------------
  if tg_op = 'DELETE'
     and current_setting('app.allow_scan_purge', true) = 'true'
     and old.author_role::text = 'scanner'
     and old.event_type = 'credential_scanned'
     and old.occurred_at < (now() - (retention_days || ' days')::interval)
  then
    -- Traceability: one audit row per deleted scan event.
    insert into public.audit_log (actor_user_id, action, payload)
    values (
      null,   -- no user actor; cron runs as service-role (no profiles.id available)
      'scan_event_purged',
      jsonb_build_object(
        'pet_event_id', old.id,
        'pet_id',       old.pet_id,
        'occurred_at',  old.occurred_at,
        'retention_days', retention_days
      )
    );

    return old;   -- allow the DELETE
  end if;

  -- -------------------------------------------------------------------------
  -- Default: block all other mutations.
  -- -------------------------------------------------------------------------
  raise exception 'pet_events is append-only (AGENTS.md). % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- Triggers are already in place from db/triggers.sql; no drop/create needed here
-- because the function name and trigger binding are unchanged.
-- Re-running db:reset will re-apply db/triggers.sql anyway; this migration only
-- needs to replace the function body in environments that applied the original
-- function without a full reset.
