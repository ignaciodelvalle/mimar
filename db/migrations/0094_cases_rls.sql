-- Cases RLS — consolidate into the migration tree (V0-4, P0 — data security).
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Migration 0086_track_rls_in_migrations.sql consolidated RLS for 30 tables
-- into the versioned migration tree but MISSED `cases`. The `cases` RLS was
-- defined in db/cases_rls.sql (reference file) and originally applied only by
-- scripts/db-bootstrap.ts. After 0086 removed db/cases_rls.sql from the
-- bootstrap apply-order, fresh CI environments had NO RLS on `cases`:
--   - pg_class.relrowsecurity = false on public.cases
--   - `other_user.cases.select` returned `allow` (PostgREST served all rows)
--
-- This migration is the single tracked source of truth for `cases` RLS,
-- porting ALL content from db/cases_rls.sql exactly and following the
-- idempotency style of 0086.
--
-- IDEMPOTENCY
-- -----------
-- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is a no-op when already enabled.
-- Every policy uses DROP POLICY IF EXISTS before CREATE POLICY.
-- Safe to re-run on any DB state.
--
-- POLICY SEMANTICS
-- ----------------
-- The function can_read_case(p_case_id, p_user_id) is already defined and kept
-- current by migration 0034_cases_rls_expanded.sql (which replays before this
-- one). This migration does NOT redefine that function — it only enables RLS
-- and attaches the SELECT policy that delegates to it.

BEGIN;

-- ===========================================================================
-- Enable RLS on cases
-- ===========================================================================

alter table public.cases enable row level security;

-- ===========================================================================
-- cases SELECT — delegate to can_read_case
-- ===========================================================================

drop policy if exists cases_select_subject_owner on public.cases;
drop policy if exists cases_select_admin on public.cases;
drop policy if exists cases_select_visible on public.cases;

create policy cases_select_visible on public.cases for select
  using (public.can_read_case(id, auth.uid()));

-- No INSERT / UPDATE / DELETE policies — every writer goes through Drizzle on
-- the server which bypasses RLS via the service role. Deny-all for
-- INSERT/UPDATE/DELETE to PostgREST is the correct safe default.

COMMIT;
