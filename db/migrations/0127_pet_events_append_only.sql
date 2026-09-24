-- Migration 0127: create the pet_events append-only triggers in the migration
-- tree (DB-integrity review 2026-07-04, items 01/09/10 — C1 CRITICAL).
--
-- THE GAP
-- -------
-- The pet_events append-only ENFORCEMENT is split across two places today:
--   - enforce_pet_events_append_only() (the FUNCTION) is created by a migration
--     (0104, search_path hardened by 0114) — so a migrate-only deploy HAS it.
--   - pet_events_no_update / pet_events_no_delete (the TRIGGERS that bind that
--     function to the table) live ONLY in db/triggers.sql, applied by
--     scripts/db-bootstrap.ts step 3. A migrate-only production deploy
--     (`pnpm db:migrate`) never runs db/triggers.sql, so it ships pet_events
--     WITHOUT the append-only triggers — the function exists but nothing calls
--     it. The append-only spine is unprotected against direct/service_role
--     UPDATE/DELETE (RLS does not cover the postgres/BYPASSRLS connection).
--
-- case_events got this treatment in 0121; audit_log has always had its triggers
-- in a migration (0010). pet_events — the single most important append-only
-- table — was the one left bootstrap-only. This migration closes that.
--
-- IDEMPOTENCY
-- -----------
-- Safe on a DB that already has these objects (every current environment does,
-- via bootstrap): CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS / CREATE.
-- The function body below is byte-for-byte the db/triggers.sql version (general
-- override hatch + narrow scan-purge hatch, search_path pinned per 0114); both
-- files stay in sync.
--
-- search_path pinned to '' (advisor function_search_path_mutable, 0114); every
-- object reference is schema-qualified.

create or replace function public.enforce_pet_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  override_actor uuid;
  retention_days int := 90;
begin
  -- Path 1: general mutation escape hatch. Requires BOTH
  -- app.allow_event_mutation AND app.allow_event_mutation_actor (accountability).
  if current_setting('app.allow_event_mutation', true) = 'true' then
    override_actor := nullif(current_setting('app.allow_event_mutation_actor', true), '')::uuid;
    if override_actor is null then
      raise exception 'pet_events mutation override requires app.allow_event_mutation_actor (uuid) to be set in the same session'
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

  -- Path 2: narrow scan-purge exception (Wave 5 Item 28, migration 0104).
  -- DELETE only; scanner-authored credential_scanned events only; older than
  -- the retention window only.
  if tg_op = 'DELETE'
     and current_setting('app.allow_scan_purge', true) = 'true'
     and old.author_role::text = 'scanner'
     and old.event_type = 'credential_scanned'
     and old.occurred_at < (now() - (retention_days || ' days')::interval)
  then
    insert into public.audit_log (actor_user_id, action, payload)
    values (
      null,
      'scan_event_purged',
      jsonb_build_object(
        'pet_event_id', old.id,
        'pet_id',       old.pet_id,
        'occurred_at',  old.occurred_at,
        'retention_days', retention_days
      )
    );

    return old;
  end if;

  -- Default: block all other mutations.
  raise exception 'pet_events is append-only (AGENTS.md). % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists pet_events_no_update on public.pet_events;
create trigger pet_events_no_update
  before update on public.pet_events
  for each row execute function public.enforce_pet_events_append_only();

drop trigger if exists pet_events_no_delete on public.pet_events;
create trigger pet_events_no_delete
  before delete on public.pet_events
  for each row execute function public.enforce_pet_events_append_only();
