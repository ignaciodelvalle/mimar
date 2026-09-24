-- Scheduling system — Row Level Security
-- ----------------------------------------
-- NOTE (V0-4): REFERENCE ONLY. Source of truth is
-- db/migrations/0086_track_rls_in_migrations.sql. No longer applied by bootstrap.
-- Governs PostgREST access (defense-in-depth). All Drizzle server-action
-- queries bypass RLS via the direct DB connection.
-- DO NOT APPLY THIS FILE (A02-2). Migrations are the only path that changes a
-- database: write a forward-only db/migrations/NNNN_*.sql, applied by
-- db:migrate. Pasting this file into the Supabase Studio SQL Editor would
-- re-create policies later migrations dropped (0175, 0211, 0212, …).

-- ============================================================================
-- service_offerings
-- ============================================================================
alter table public.service_offerings enable row level security;

-- Approved offerings are publicly readable (owners need to search them).
drop policy if exists "service_offerings read approved publicly" on public.service_offerings;
create policy "service_offerings read approved publicly"
  on public.service_offerings for select
  to anon, authenticated
  using (status = 'approved');

-- Org members can read all their org's offerings regardless of status
-- (so they can see pending/rejected state in the dashboard).
drop policy if exists "service_offerings read by org members" on public.service_offerings;
create policy "service_offerings read by org members"
  on public.service_offerings for select
  to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );

-- Independent-vet provider can read their own offerings.
drop policy if exists "service_offerings read by provider vet" on public.service_offerings;
create policy "service_offerings read by provider vet"
  on public.service_offerings for select
  to authenticated
  using (provider_user_id = auth.uid());

-- INSERT / UPDATE / DELETE: server actions only (no PostgREST mutations).
-- RLS denies by default for unauthenticated and non-owner callers.

-- ============================================================================
-- service_schedule_rules
-- ============================================================================
alter table public.service_schedule_rules enable row level security;

-- Org members can read rules for their org's offerings.
drop policy if exists "schedule_rules read by org members" on public.service_schedule_rules;
create policy "schedule_rules read by org members"
  on public.service_schedule_rules for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where organization_id in (
        select organization_id from public.organization_memberships
        where user_id = auth.uid() and left_at is null
      )
    )
  );

-- Independent-vet provider can read their own rules.
drop policy if exists "schedule_rules read by provider vet" on public.service_schedule_rules;
create policy "schedule_rules read by provider vet"
  on public.service_schedule_rules for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = auth.uid()
    )
  );

-- ============================================================================
-- time_slots
-- ============================================================================
-- Availability is open data: any authenticated or anonymous user can see slots
-- (they need this to search for bookable times).
alter table public.time_slots enable row level security;

drop policy if exists "time_slots read publicly" on public.time_slots;
create policy "time_slots read publicly"
  on public.time_slots for select
  to anon, authenticated
  using (true);

-- ============================================================================
-- appointments
-- ============================================================================
alter table public.appointments enable row level security;

-- Owner can read their own appointments.
drop policy if exists "appointments read by owner" on public.appointments;
create policy "appointments read by owner"
  on public.appointments for select
  to authenticated
  using (owner_user_id = auth.uid());

-- Org members can read appointments for their org's offerings.
drop policy if exists "appointments read by org members" on public.appointments;
create policy "appointments read by org members"
  on public.appointments for select
  to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );

-- Independent-vet provider can read appointments for their offerings.
drop policy if exists "appointments read by provider vet" on public.appointments;
create policy "appointments read by provider vet"
  on public.appointments for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = auth.uid()
    )
  );
