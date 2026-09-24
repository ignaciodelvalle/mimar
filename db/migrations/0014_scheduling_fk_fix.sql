-- Fix-up for migration 0013 — three FKs in scheduling tables were declared
-- without an ON DELETE clause (defaulting to NO ACTION / restrict). The
-- Drizzle schema model in db/schema.ts declares them all as SET NULL, which
-- is the intended behavior — these columns audit "who did the thing" and
-- should NULL when the actor's profile is deleted, not block the cascade.
--
-- Symptom that surfaced this drift: integration tests in
-- __tests__/scheduling-attendance.test.ts failed at cleanup with
-- "appointments_attended_by_user_id_fkey violates FK constraint" when
-- purging test user profiles.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. Re-runnable on
-- environments where 0013 already landed in either state.

-- service_offerings.reviewed_by_user_id
do $$ begin
  alter table public.service_offerings
    drop constraint if exists service_offerings_reviewed_by_user_id_fkey;
end $$;
alter table public.service_offerings
  add constraint service_offerings_reviewed_by_user_id_fkey
    foreign key (reviewed_by_user_id) references public.profiles(id) on delete set null;

-- appointments.attended_by_user_id
do $$ begin
  alter table public.appointments
    drop constraint if exists appointments_attended_by_user_id_fkey;
end $$;
alter table public.appointments
  add constraint appointments_attended_by_user_id_fkey
    foreign key (attended_by_user_id) references public.profiles(id) on delete set null;

-- appointments.cancelled_by_user_id
do $$ begin
  alter table public.appointments
    drop constraint if exists appointments_cancelled_by_user_id_fkey;
end $$;
alter table public.appointments
  add constraint appointments_cancelled_by_user_id_fkey
    foreign key (cancelled_by_user_id) references public.profiles(id) on delete set null;

-- appointments.service_offering_id — should CASCADE so deleting an offering
-- cleans up its planning artifacts (appointments are operational, not history;
-- attended appointments already wrote their immutable pet_events).
do $$ begin
  alter table public.appointments
    drop constraint if exists appointments_service_offering_id_fkey;
end $$;
alter table public.appointments
  add constraint appointments_service_offering_id_fkey
    foreign key (service_offering_id) references public.service_offerings(id) on delete cascade;

-- appointments.organization_id — when the org is deleted, its denormalized
-- appointment rows should disappear too.
do $$ begin
  alter table public.appointments
    drop constraint if exists appointments_organization_id_fkey;
end $$;
alter table public.appointments
  add constraint appointments_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete cascade;

-- appointments.outcome_event_id — Drizzle declares SET NULL. In prod the
-- append-only trigger blocks pet_events deletion so this FK is moot; in tests
-- the cleanup uses the GUC bypass to delete pet_events, and the appointment
-- row's pointer must null out instead of blocking.
do $$ begin
  alter table public.appointments
    drop constraint if exists appointments_outcome_event_id_fkey;
end $$;
alter table public.appointments
  add constraint appointments_outcome_event_id_fkey
    foreign key (outcome_event_id) references public.pet_events(id) on delete set null;
