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

-- Since 0279: anon holds nothing on this table, and authenticated holds
-- SELECT on (id, organization_id, provider_user_id) only — what the
-- appointments / service_schedule_rules policies sub-select. The public
-- catalogue (search, org page, booking) is rendered server-side over Drizzle;
-- "service_offerings read approved publicly" used to hand anon the whole row
-- (provider, reviewer, rejection reason) and was dropped.
revoke all on public.service_offerings from public, anon, authenticated;
grant select (id, organization_id, provider_user_id) on public.service_offerings to authenticated;
drop policy if exists "service_offerings read approved publicly" on public.service_offerings;

-- Org members can read all their org's offerings regardless of status
-- (so they can see pending/rejected state in the dashboard). Through the
-- caller-only definer helper (0273): a direct subquery on
-- organization_memberships recursed into its peers policy until 0279.
drop policy if exists "service_offerings read by org members" on public.service_offerings;
create policy "service_offerings read by org members"
  on public.service_offerings for select
  to authenticated
  using (public.caller_is_active_org_member(organization_id));

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

-- Org members can read rules for their org's offerings. Through the
-- caller-only definer helper since 0285 (byte-identical to that migration):
-- a direct subquery on organization_memberships recursed into its peers
-- policy and made every authenticated read of this table raise.
drop policy if exists "schedule_rules read by org members" on public.service_schedule_rules;
create policy "schedule_rules read by org members"
  on public.service_schedule_rules for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where public.caller_is_active_org_member(organization_id)
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

-- Org members can read appointments for their org's offerings. Through the
-- caller-only definer helper since 0285 (byte-identical to that migration),
-- for the same recursion as service_schedule_rules above.
drop policy if exists "appointments read by org members" on public.appointments;
create policy "appointments read by org members"
  on public.appointments for select
  to authenticated
  using (public.caller_is_active_org_member(organization_id));

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
