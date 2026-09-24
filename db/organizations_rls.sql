-- DIM organizations — Row Level Security
-- ---------------------------------------
-- NOTE (V0-4): REFERENCE ONLY. Source of truth is
-- db/migrations/0086_track_rls_in_migrations.sql. No longer applied by bootstrap.
-- Conservative read-only RLS for the three organization tables. v1 has no
-- self-serve admin UI for orgs; INSERT/UPDATE/DELETE happen via Supabase Studio
-- by an admin until the refugio portal lands. See AGENTS.md → Organizations.
--
-- DO NOT APPLY THIS FILE (A02-2). Migrations are the only path that changes a
-- database: write a forward-only db/migrations/NNNN_*.sql, applied by
-- db:migrate. Pasting this file into the Supabase Studio SQL Editor would
-- re-create policies later migrations dropped (0175, 0211, 0212, …).
--
-- NOTE: This RLS only governs queries via PostgREST (supabase-js client).
-- All Drizzle queries bypass it (direct DB connection). This is defense-in-depth,
-- matching db/welfare_rls.sql conventions.

-- ============================================================================
-- organizations
-- ============================================================================
alter table public.organizations enable row level security;

-- Verified orgs are publicly readable (powers public org pages and tier-0
-- branding on credentials). Unverified orgs stay invisible to PostgREST.
drop policy if exists "Verified orgs are publicly readable" on public.organizations;
create policy "Verified orgs are publicly readable"
  on public.organizations
  for select
  to anon, authenticated
  using (verified = true);

-- Org members can read their own org regardless of verification status.
drop policy if exists "Members can read their own org" on public.organizations;
create policy "Members can read their own org"
  on public.organizations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );

-- No insert / update / delete in v1. Admin-only via Studio until verified-invite
-- flow lands.

-- ============================================================================
-- organization_coverage
-- ============================================================================
alter table public.organization_coverage enable row level security;

-- Coverage rows are readable when the parent org is verified (powers the
-- adoption-listing and broadcast-target filters).
drop policy if exists "Coverage readable when parent org is verified" on public.organization_coverage;
create policy "Coverage readable when parent org is verified"
  on public.organization_coverage
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.organizations o
      where o.id = organization_coverage.organization_id
        and o.verified = true
    )
  );

-- Org members can read their own coverage regardless of verification.
drop policy if exists "Members can read their org coverage" on public.organization_coverage;
create policy "Members can read their org coverage"
  on public.organization_coverage
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = organization_coverage.organization_id
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );

-- No insert / update / delete in v1.

-- ============================================================================
-- organization_memberships
-- ============================================================================
alter table public.organization_memberships enable row level security;

-- A user can always read their own membership rows.
drop policy if exists "Members can read their own memberships" on public.organization_memberships;
create policy "Members can read their own memberships"
  on public.organization_memberships
  for select
  to authenticated
  using (user_id = auth.uid());

-- Members of an org can see other members of the same org.
-- The `peer` alias on the inner SELECT is REQUIRED — without it, the unqualified
-- `organization_memberships.organization_id` in both the outer USING and the inner
-- WHERE refer to the same row, and Postgres re-enters this policy when evaluating
-- the EXISTS subquery (because `peer` is also under RLS), leading to either
-- infinite recursion or empty results depending on the planner's choice.
-- Aliasing as `peer` makes the inner reference unambiguous and bounded.
drop policy if exists "Members can read peers in same org" on public.organization_memberships;
create policy "Members can read peers in same org"
  on public.organization_memberships
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_memberships peer
      where peer.organization_id = organization_memberships.organization_id
        and peer.user_id = auth.uid()
        and peer.left_at is null
    )
  );

-- No insert / update / delete in v1.

-- ----------------------------------------------------------------------------
-- pet_events write policies: there are none, and that is deliberate
-- ----------------------------------------------------------------------------
-- Since db/migrations/0212_pet_events_lock_postgrest_writes.sql (2026-09-02),
-- public.pet_events carries NO INSERT, UPDATE or DELETE policy for anon or
-- authenticated. 0212 dropped the owner-self INSERT policy this section used to
-- point at (its WITH CHECK left author_role / author_verified unconstrained, so
-- any owner could self-issue an institutionally-verified event) and refuses to
-- complete if a caller-reachable write policy survives under any name. Reads
-- are untouched -- owners keep a SELECT policy, and 0212 fails if that is gone
-- too.
--
-- Every legitimate append reaches this table over the Drizzle connection as a
-- BYPASSRLS role, through src/modules/events/infrastructure, so the count of
-- legitimate PostgREST writers is zero and deny-all is the exact policy rather
-- than a blunt one. 0212's header carries the enumeration.
--
-- So the org-attributed branch (author_organization_id IS NOT NULL, gated on an
-- active organization_membership with can_write_pet_events = true) is not
-- merely "not written yet": opening it when the refugio / professional portal
-- lands takes a NEW migration that argues against 0212, not an edit here. This
-- file is a REFERENCE SNAPSHOT (see the header) and applying it grants nothing.
