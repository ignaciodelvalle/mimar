-- Migration 0121: enforce case_events append-only at the DB level.
--
-- Event-sourcing integrity review 2026-07-04, item 3. Migration 0069 created
-- case_events as "append-only by convention (no UPDATE trigger yet; add when
-- needed)". case_events now carries case timelines for outbreak
-- investigations, decomiso, welfare, and other general-subject cases — the
-- same forensic weight as pet_events — so the convention gets teeth.
--
-- Mirrors enforce_pet_events_append_only (db/triggers.sql):
--   - BEFORE UPDATE / BEFORE DELETE row triggers block every mutation.
--   - One narrow escape hatch for accountable admin repair, reusing the SAME
--     session GUCs as pet_events so a single override session covers both
--     append-only event tables:
--       set local app.allow_event_mutation = 'true';
--       set local app.allow_event_mutation_actor = '<admin profile uuid>';
--     Every override writes an audit_log row (action =
--     'case_events_mutation_override'). Without the actor GUC the mutation is
--     refused — the hatch is unusable without accountability.
--   - No scan-purge path: case_events has no retention-purged event kind.
--
-- Interaction with 0069's case_id ON DELETE CASCADE: deleting a cases row
-- now fails when it has timeline rows, unless the session holds the override
-- GUCs (the cascaded deletes fire these triggers in the same session, so
-- withMutationOverride-style cleanup keeps working). That is intended — a
-- case with recorded history is a forensic record, same stance as
-- pet_events.case_id ON DELETE RESTRICT.
--
-- search_path pinned to '' (advisor function_search_path_mutable — same
-- hardening as migration 0114); all object refs are schema-qualified.
--
-- NOTE: db/triggers.sql carries the same function + triggers for fresh
-- bootstraps (it re-runs after migrations); keep both in sync.

create or replace function public.enforce_case_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  override_actor uuid;
begin
  if current_setting('app.allow_event_mutation', true) = 'true' then
    override_actor := nullif(current_setting('app.allow_event_mutation_actor', true), '')::uuid;
    if override_actor is null then
      raise exception 'case_events mutation override requires app.allow_event_mutation_actor (uuid) to be set in the same session'
        using errcode = 'restrict_violation';
    end if;

    insert into public.audit_log (actor_user_id, action, payload)
    values (
      override_actor,
      'case_events_mutation_override',
      jsonb_build_object(
        'operation',     tg_op,
        'case_event_id', coalesce(new.id,          old.id),
        'case_id',       coalesce(new.case_id,     old.case_id),
        'entry_type',    coalesce(new.entry_type,  old.entry_type),
        'occurred_at',   coalesce(new.occurred_at, old.occurred_at)
      )
    );

    return coalesce(new, old);
  end if;

  raise exception 'case_events is append-only (AGENTS.md). % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists case_events_no_update on public.case_events;
create trigger case_events_no_update
  before update on public.case_events
  for each row execute function public.enforce_case_events_append_only();

drop trigger if exists case_events_no_delete on public.case_events;
create trigger case_events_no_delete
  before delete on public.case_events
  for each row execute function public.enforce_case_events_append_only();
