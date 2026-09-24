-- DIM foster volunteers pool — Row Level Security
-- ------------------------------------------------
-- NOTE (V0-4): REFERENCE ONLY. Source of truth is
-- db/migrations/0086_track_rls_in_migrations.sql. No longer applied by bootstrap.
-- Spec foster-volunteers-pool v1.4 §8.
-- DO NOT APPLY THIS FILE (A02-2). Migrations are the only path that changes a
-- database: write a forward-only db/migrations/NNNN_*.sql, applied by
-- db:migrate. Pasting this file into the Supabase Studio SQL Editor would
-- re-create policies later migrations dropped (0175, 0211, 0212, …).
--
-- NOTE: All writes go through server actions running with the service role
-- (Drizzle direct connection), bypassing RLS. The policies below ONLY govern
-- reads done via PostgREST (supabase-js from the browser, if/when used).
-- Defense-in-depth.

-- foster_volunteers ------------------------------------------------------

alter table public.foster_volunteers enable row level security;

-- 1. Each volunteer can read their own row (preferences, slots, status).
drop policy if exists "Volunteer can read own row" on public.foster_volunteers;
create policy "Volunteer can read own row"
  on public.foster_volunteers
  for select
  to authenticated
  using (user_id = auth.uid());

-- 2. Org members with `foster.assign` capability can read the active pool —
-- only rows where status='active' AND available_slots > 0. Admins of the org
-- hold every capability implicitly (no row in organization_capability_grants).
drop policy if exists "Org coordinators can read active pool" on public.foster_volunteers;
create policy "Org coordinators can read active pool"
  on public.foster_volunteers
  for select
  to authenticated
  using (
    status = 'active'
    and available_slots > 0
    and exists (
      select 1
      from public.organization_memberships om
      where om.user_id = auth.uid()
        and om.left_at is null
        and (
          om.role = 'admin'
          or exists (
            select 1
            from public.organization_capability_grants ocg
            where ocg.membership_id = om.id
              and ocg.capability = 'foster.assign'
              and ocg.status = 'approved'
          )
        )
    )
  );

-- 3. Platform admins (account_type='institutional' AND role='admin') can read
-- every row — needed by admin dashboards.
drop policy if exists "Platform admins read all volunteers" on public.foster_volunteers;
create policy "Platform admins read all volunteers"
  on public.foster_volunteers
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
        and p.deleted_at is null
    )
  );

-- NO INSERT / UPDATE / DELETE policies. Server actions handle all writes.

-- foster_proposals -------------------------------------------------------

alter table public.foster_proposals enable row level security;

-- 1. The volunteer the proposal targets can read it.
drop policy if exists "Volunteer can read proposals for them" on public.foster_proposals;
create policy "Volunteer can read proposals for them"
  on public.foster_proposals
  for select
  to authenticated
  using (volunteer_user_id = auth.uid());

-- 2. Any active member of the proposing org can read it (the org's queue).
drop policy if exists "Org members can read own org proposals" on public.foster_proposals;
create policy "Org members can read own org proposals"
  on public.foster_proposals
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships om
      where om.user_id = auth.uid()
        and om.organization_id = foster_proposals.organization_id
        and om.left_at is null
    )
  );

-- 3. Platform admins can read every proposal.
drop policy if exists "Platform admins read all proposals" on public.foster_proposals;
create policy "Platform admins read all proposals"
  on public.foster_proposals
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
        and p.deleted_at is null
    )
  );

-- NO INSERT / UPDATE / DELETE policies. Server actions handle all writes.
