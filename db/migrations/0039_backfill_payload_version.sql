-- Migration 0039 — backfill payload_version on historical pet_events rows.
-- Spec: Phase 4.4 (action plan 2026-05-20). Engram: dim/phase-4-4-payload-version-plan.
--
-- New writes already get `payload_version: 1` via the Zod schema defaults in
-- lib/event-schemas.ts (every schema is `z.object(withVersion({...})).strict()`
-- — withVersion injects `payload_version: z.literal(1).default(1)`). This
-- migration seeds the same field on every existing row that lacks it, so the
-- (future) upcaster registry can rely on every row carrying its writer's
-- version.
--
-- The pet_events append-only trigger (db/triggers.sql, introduced by #56)
-- blocks UPDATE on pet_events unless the session sets BOTH
-- `app.allow_event_mutation = 'true'` and `app.allow_event_mutation_actor`
-- (a uuid). This migration uses that escape hatch. The trigger writes one
-- `audit_log` row per updated row with action `pet_events_mutation_override`
-- attributed to the sentinel actor uuid — that is the audit trail for the
-- bulk mutation, per #56's contract.
--
-- Idempotent — re-running this migration is a no-op once every row has the
-- field. Batched in 10k chunks so a large pet_events table doesn't hold an
-- exclusive lock for the whole operation.

-- The trigger requires the override actor to be a real profile (audit_log
-- has FK actor_user_id -> profiles.id on delete restrict). Create a
-- sentinel profile for system-driven migrations the first time we need it.
-- The fixed uuid `…000039` matches this migration number so future readers
-- can trace the bulk audit rows back to where they came from. ON CONFLICT
-- DO NOTHING keeps it idempotent.
insert into public.profiles (id, role, display_name, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000039',
  'admin',
  'system:backfill-0039',
  now(),
  now()
)
on conflict (id) do nothing;

do $$
declare
  batch_size int := 10000;
  updated    int;
  total      int := 0;
begin
  -- Set the escape-hatch GUCs for this transaction (drizzle-kit migrate runs
  -- each migration as a single transaction; the GUCs reset at COMMIT).
  perform set_config('app.allow_event_mutation', 'true', true);
  perform set_config(
    'app.allow_event_mutation_actor',
    '00000000-0000-0000-0000-000000000039',
    true
  );

  loop
    update public.pet_events
    set    payload = payload || jsonb_build_object('payload_version', 1)
    where  id in (
      select id
      from   public.pet_events
      where  not (payload ? 'payload_version')
      limit  batch_size
    );
    get diagnostics updated = row_count;
    total := total + updated;
    exit when updated = 0;
  end loop;

  raise notice 'Migration 0039: backfilled payload_version on % pet_events rows', total;
end $$;

-- Verification: zero rows should lack payload_version after this migration.
-- Raising here aborts the transaction so a partial backfill never commits.
do $$
declare
  missing int;
begin
  select count(*) into missing
  from   public.pet_events
  where  not (payload ? 'payload_version');

  if missing > 0 then
    raise exception 'Migration 0039 verification failed: % pet_events rows still lack payload_version', missing;
  end if;
end $$;
