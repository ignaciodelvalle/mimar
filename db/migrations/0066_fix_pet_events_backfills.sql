-- Migration 0066 — fix-forward: backfill pet_events that 0063/0065 could not.
--
-- 0063 (sighting `kind` discriminator) and 0065 (scanner -> finder author_role)
-- issued plain UPDATEs on pet_events. The append-only trigger
-- (public.enforce_pet_events_append_only, db/triggers.sql) BLOCKS any UPDATE on
-- that table, so both backfills failed wherever matching rows existed. They went
-- unnoticed because the "schema vs migrations drift" CI job only runs
-- `drizzle-kit push` (never the SQL files) and `db:bootstrap` replays migrations
-- best-effort, swallowing errors. New writes are unaffected (the sighting action
-- sets `kind` and the encontre action sets author_role 'finder' directly); only
-- the historical backfill was missing.
--
-- This re-runs both backfills using the trigger's documented escape hatch
-- (app.allow_event_mutation + app.allow_event_mutation_actor), mirroring
-- migration 0039. The trigger writes one audit_log row per mutated row,
-- attributed to the sentinel actor below.
--
-- Idempotent: both UPDATEs are guarded (kind discriminator / author_role value),
-- so re-running is a no-op once applied. Safe on a fresh DB (0 matching rows).

-- Sentinel actor for the override audit rows (audit_log.actor_user_id has an FK
-- to profiles.id). The fixed uuid ...000066 traces the bulk audit rows back to
-- this migration. ON CONFLICT DO NOTHING keeps it idempotent.
insert into public.profiles (id, role, display_name, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000066',
  'admin',
  'system:backfill-0066',
  now(),
  now()
)
on conflict (id) do nothing;

do $$
declare
  remaining int;
begin
  -- Escape-hatch GUCs (transaction-local; reset at COMMIT). Required by
  -- enforce_pet_events_append_only to permit the bulk mutation + audit it.
  perform set_config('app.allow_event_mutation', 'true', true);
  perform set_config(
    'app.allow_event_mutation_actor',
    '00000000-0000-0000-0000-000000000066',
    true
  );

  -- Backfill A (was 0063): legacy "[Avistaje]" notes -> structured sighting.
  -- Strips the "[Avistaje] " prefix (optional trailing space) and stamps
  -- payload.kind = 'sighting' so fetchLostEpisodeForPet counts them and the
  -- unified feed surfaces them.
  update public.pet_events
  set    payload = payload
           || jsonb_build_object('text', regexp_replace(payload->>'text', '^\[Avistaje\] ?', '', ''))
           || jsonb_build_object('kind', 'sighting')
  where  event_type = 'note_added'
    and  payload->>'text' like '[Avistaje]%'
    and  (payload->>'kind') is distinct from 'sighting';

  -- Backfill B (was 0065): finder-in-possession events authored before the
  -- 'finder' enum value existed fell back to 'scanner'.
  update public.pet_events
  set    author_role = 'finder'
  where  event_type = 'note_added'
    and  payload->>'kind' = 'finder_in_possession'
    and  author_role = 'scanner';

  -- Verification (same transaction — a RAISE aborts the whole backfill).
  select count(*) into remaining
  from   public.pet_events
  where  event_type = 'note_added'
    and  payload->>'text' like '[Avistaje]%'
    and  (payload->>'kind') is distinct from 'sighting';
  if remaining > 0 then
    raise exception 'Migration 0066 verification failed: % legacy [Avistaje] note_added rows still unmigrated', remaining;
  end if;
end $$;
