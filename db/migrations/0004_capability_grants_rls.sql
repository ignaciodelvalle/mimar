-- DIM organization capability grants — Row Level Security
-- ---------------------------------------------------------
-- Read-only RLS for organization_capability_grants. v1 server actions (under
-- app/actions/capabilities.ts) write via Drizzle's direct connection, which
-- bypasses RLS by design. This file is defense-in-depth for any future
-- PostgREST query against the table.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor.
-- Idempotent — safe to re-run.

alter table public.organization_capability_grants enable row level security;

-- A member can always read their own grants (theirs, on memberships they hold).
drop policy if exists "Members can read their own grants" on public.organization_capability_grants;
create policy "Members can read their own grants"
  on public.organization_capability_grants
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships m
      where m.id = organization_capability_grants.membership_id
        and m.user_id = auth.uid()
    )
  );

-- Admins (role = 'admin' on an active membership) can read every grant in
-- their org. This powers the approval queue if it ever flips to a PostgREST
-- client. Aliased as `admin_m` to avoid the recursion trap documented in
-- organizations_rls.sql.
drop policy if exists "Admins can read all grants in their org" on public.organization_capability_grants;
create policy "Admins can read all grants in their org"
  on public.organization_capability_grants
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships admin_m
      where admin_m.organization_id = organization_capability_grants.organization_id
        and admin_m.user_id = auth.uid()
        and admin_m.role = 'admin'
        and admin_m.left_at is null
    )
  );

-- No insert / update / delete in v1. Server actions (Drizzle, service-role
-- connection) handle every write. Adding write policies here would require
-- duplicating the authorization logic in SQL; we prefer single-source-of-truth
-- in app/actions/capabilities.ts.
