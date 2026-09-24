-- Migration 0036 — pets.pregnancy_status denormalized flag.
-- Spec: 2026-05-19-pregnancy-tracking-design (PR4).
--
-- Adds a denormalized status column on `pets` so queries like "all
-- pregnancies in_progress within jurisdiction X" don't require a
-- pet_events scan. Re-derivable from clinical_info_logged events with
-- sub_kind='pregnancy'. Server actions dual-write it.
--
-- Allowed values:
--   null                       — never pregnant or no record
--   in_progress                — pregnancy_started without matching _ended
--   completed_live_birth       — ended with outcome=live_birth
--   completed_stillbirth       — ended with outcome=stillbirth
--   completed_miscarriage      — ended with outcome=miscarriage
--   completed_termination      — ended with outcome=termination
--   completed_unknown          — ended with outcome=unknown
--
-- Idempotent — safe to re-run.

alter table public.pets
  add column if not exists pregnancy_status text;

do $$ begin
  alter table public.pets drop constraint if exists pets_pregnancy_status_valid;
exception when others then null; end $$;

alter table public.pets
  add constraint pets_pregnancy_status_valid
  check (
    pregnancy_status is null
    or pregnancy_status in (
      'in_progress',
      'completed_live_birth',
      'completed_stillbirth',
      'completed_miscarriage',
      'completed_termination',
      'completed_unknown'
    )
  );

create index if not exists pets_pregnancy_active_idx
  on public.pets (id)
  where pregnancy_status = 'in_progress';
