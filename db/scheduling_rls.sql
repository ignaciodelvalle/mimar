-- Scheduling system — Row Level Security
-- ----------------------------------------
-- APPLIED BY scripts/deploy-provision.ts (step 4, LOOSE_SQL_ORDER), AFTER the
-- migration replay — so every statement here is the LAST word on a freshly
-- provisioned database. Migrations stay the source of truth (0086 ported this
-- file): a change here is written as a forward-only db/migrations/NNNN_*.sql
-- first and mirrored here. Since 0285 the mirror is byte-identical between
-- that migration's `-- >>> scheduling_rls.sql mirror` markers, which the
-- scheduling RLS tests pin (0285, 0286, 0288, 0290). Until 0290 a provision
-- diverged from a migrated database: 0137's `(select auth.uid())` initplan
-- wrap of the owner and provider-vet policies was not carried here, so four
-- policies came back with a bare auth.uid() (same access, slower plan). 0290
-- re-issued them and __tests__/rls/scheduling-provision-convergence.test.ts
-- now applies this whole file over the migrated catalog and asserts nothing
-- moves. A statement here that a later migration dropped would put it back on
-- every provision — that test catches it.
-- db:migrate never applies this file, and neither does db-bootstrap.
-- Governs PostgREST access (defense-in-depth). All Drizzle server-action
-- queries bypass RLS via the direct DB connection.

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
  using (provider_user_id = (select auth.uid()));

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
      where provider_user_id = (select auth.uid())
    )
  );

-- ============================================================================
-- time_slots
-- ============================================================================
-- Since 0286 (byte-identical to that migration): the offering's org members
-- and its provider vet only, the audience of service_schedule_rules. The old
-- "time_slots read publicly" (TO anon, authenticated USING (true)) handed the
-- capacity and live occupancy of every agenda to the publishable key. Owner
-- search and booking read slots server-side over Drizzle, never PostgREST.
alter table public.time_slots enable row level security;
revoke all on public.time_slots from anon;

drop policy if exists "time_slots read publicly" on public.time_slots;

drop policy if exists "time_slots read by org members" on public.time_slots;
create policy "time_slots read by org members"
  on public.time_slots for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where public.caller_is_active_org_member(organization_id)
    )
  );

drop policy if exists "time_slots read by provider vet" on public.time_slots;
create policy "time_slots read by provider vet"
  on public.time_slots for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = (select auth.uid())
    )
  );

-- ============================================================================
-- appointments
-- ============================================================================
alter table public.appointments enable row level security;

-- Owner can read their own appointments.
drop policy if exists "appointments read by owner" on public.appointments;
create policy "appointments read by owner"
  on public.appointments for select
  to authenticated
  using (owner_user_id = (select auth.uid()));

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
      where provider_user_id = (select auth.uid())
    )
  );

-- ============================================================================
-- institutional sessions require aal2 (0231 house rule)
-- ============================================================================
-- Since 0288 (byte-identical to that migration): a restrictive policy AND-ed
-- with every permissive one above, so an institutional account holding only
-- a password (aal1) token reads none of these three tables (0290 adds
-- service_offerings below, for four). Personal
-- accounts — owners, the provider vet, personal-account members — pass it.
drop policy if exists "institutional sessions require aal2" on public.service_schedule_rules;
create policy "institutional sessions require aal2" on public.service_schedule_rules
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));

drop policy if exists "institutional sessions require aal2" on public.time_slots;
create policy "institutional sessions require aal2" on public.time_slots
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));

drop policy if exists "institutional sessions require aal2" on public.appointments;
create policy "institutional sessions require aal2" on public.appointments
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));

-- Since 0290 (byte-identical to that migration): service_offerings too. Its
-- column grant above does not survive deploy-provision's re-grant (step 5),
-- so on a provisioned database the org-member branch would otherwise hand an
-- aal1 institutional member the whole row.
drop policy if exists "institutional sessions require aal2" on public.service_offerings;
create policy "institutional sessions require aal2" on public.service_offerings
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));
