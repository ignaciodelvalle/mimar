-- Bite reporting + 10-day rabies observation foundation.
--
-- Anchored in Decreto 4669/1973 (Provincia de Buenos Aires), Ordenanza CABA
-- 41.831/1987, and Resolución MS 1144/2018. The 10-day observation period is
-- mandatory and hardcoded — see lib/rabies-observation.ts → RABIES_OBSERVATION_DAYS.
--
-- Bite events themselves are NOT a separate event_type. They live inside
-- `incident_reported` with `payload.incident_type = 'bite_inflicted'`
-- (see lib/event-schemas.ts → incidentReported). This migration only adds the
-- observation lifecycle columns and indexes — the EVENT_TYPES extension lives
-- in db/schema.ts (no SQL needed; the TS const drives validateEventPayload).
--
-- Idempotent: every operation is guarded.
--
-- Applied via:
--   cat db/migrations/0021_bite_rabies_observation.sql | \
--     docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

-- 1) Denormalized observation state on pets. Re-derivable from pet_events via
--    lib/projections/pet-rabies-observation.ts. Dual-written by reportBiteAction
--    + the daily cron + the death-during-observation hook.
alter table public.pets
  add column if not exists rabies_observation_status text;

do $$ begin
  alter table public.pets
    add constraint pets_rabies_observation_status_valid
    check (
      rabies_observation_status is null
      or rabies_observation_status in (
        'in_progress',
        'completed_negative',
        'completed_positive_rabies',
        'completed_dead',
        'completed_lost_to_followup'
      )
    );
exception when duplicate_object then null;
end $$;

-- 2) Partial index for the cron's daily scan. Most pets have a NULL value, so
--    a full-table index would be wasteful — we only need fast lookup of the
--    currently-active observations.
create index if not exists pets_rabies_observation_in_progress_idx
  on public.pets (rabies_observation_status)
  where rabies_observation_status = 'in_progress';

comment on column public.pets.rabies_observation_status is
  '10-day rabies observation lifecycle state (per Decreto 4669/1973 PBA). null = no active observation. Dual-written from server actions and the daily cron; re-derivable from pet_events via lib/projections/pet-rabies-observation.ts.';
