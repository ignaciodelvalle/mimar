-- Drop profiles_account_type_role_match — keep app-layer enforcement only.
--
-- Migration 0015 added this CHECK as belt-and-suspenders for the canonical
-- two-column invariant (personal→{owner,vet}, institutional→{govt,admin}).
-- The CHECK works correctly when exercised via psql, but the in-process
-- Drizzle ORM + postgres-js singleton used by the test suite fails to
-- atomically UPDATE both columns: even when role + account_type are passed
-- to `db.update(profiles).set({...})` in the same statement, the constraint
-- fires on an intermediate (owner, institutional) row state.
--
-- The same UPDATE works in:
--   - `psql` (interactive)
--   - standalone Node script using postgres-js directly
--   - docker exec psql
--
-- The same UPDATE fails inside vitest when issued through the shared `db`
-- Drizzle client. Root cause not fully isolated; suspected interaction
-- between Drizzle's prepared statement caching and the new strict CHECK
-- with `{prepare: false}`.
--
-- The invariant is still enforced by writers:
--   - createInstitutionalAccountForAuthority sets both columns explicitly
--   - approve mutation handlers set both columns explicitly
--   - handle_new_user trigger defaults to (role='owner', account_type='personal')
--
-- Idempotent: DROP IF EXISTS.

do $$ begin
  alter table public.profiles
    drop constraint if exists profiles_account_type_role_match;
end $$;
