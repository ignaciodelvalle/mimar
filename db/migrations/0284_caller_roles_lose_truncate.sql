-- ────────────────────────────────────────────────────────────────────────────
-- 0284_caller_roles_lose_truncate.sql
-- anon and authenticated stop holding TRUNCATE on the public schema.
--
-- THE HOLE (security review 2026-10-06, plan A6-a)
-- ---------------------------------------------------------------------------
-- Supabase's default privileges, and scripts/deploy-provision.ts
-- applySchemaGrants (`grant all on all tables in schema public to anon,
-- authenticated, service_role`), hand both caller roles TRUNCATE on every
-- public table. Measured on a freshly bootstrapped local stack: anon held
-- TRUNCATE on 55 of 65 public tables, authenticated on 56. The ten exceptions
-- were the tables an earlier migration had revoked one by one (0266's
-- append-only spine, 0268, 0250/0251, 0273 visits, 0278-0280).
--
-- TRUNCATE is not subject to row level security and fires no row trigger, so
-- on those tables a session running as anon or authenticated could empty them
-- with no trace. PostgREST exposes no TRUNCATE verb, which is why this is a
-- low: it takes a session under those roles that is not PostgREST (a future
-- SECURITY INVOKER function running dynamic SQL, a leaked direct connection).
-- No caller-role code path needs it — the app writes through Drizzle
-- (BYPASSRLS), tests clean up with DELETE, and nothing in the tree TRUNCATEs a
-- table under a caller role.
--
-- THE FIX
-- ---------------------------------------------------------------------------
--   1. REVOKE TRUNCATE on every table in public from PUBLIC, anon and
--      authenticated. service_role is not touched here (0266 already revoked
--      it on the append-only tables, whose triggers are the fence).
--   2. The same revoke on the default privileges of the role running the
--      migrations, so a table created after this file is born without it.
--   3. scripts/deploy-provision.ts applySchemaGrants grants the caller roles an
--      explicit privilege list without TRUNCATE (same commit). Unlike a column
--      grant, a table-level REVOKE survives the provision only if the
--      provisioner stops re-granting it — the re-grant was what 0266 had to
--      fence with triggers.
--   4. A catalog fence: check 7 of scripts/check-rls-coverage.ts (lint:rls)
--      fails on any public table a caller role can TRUNCATE, and the
--      provisioner runs the same check after its grants.
--
-- Limits: ALTER DEFAULT PRIVILEGES without FOR ROLE changes only the defaults
-- of the role running the migrations (postgres); a table another role
-- creates in public (supabase_admin's own defaults grant ALL) is caught by
-- check 7, not prevented here. A public table NOT owned by the migration role
-- keeps its grants (the REVOKE only warns) and the post-condition below then
-- fails loudly — before applying remotely, list them:
--   SELECT relname, relowner::regrole FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
--      AND relowner <> current_user::regrole;
--
-- No read or write authorization changes: RLS policies are untouched, and
-- TRUNCATE was never part of any caller's product path.
--
-- Forward-only and idempotent. Behavioural fence:
-- __tests__/rls/truncate-revoked.test.ts.
-- ────────────────────────────────────────────────────────────────────────────

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(r || ':' || c.relname, ', ' ORDER BY c.relname, r) INTO offenders
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND has_table_privilege(r, c.oid, 'TRUNCATE');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0284 did not close: caller roles still hold TRUNCATE on (%)', offenders;
  END IF;
END
$$;
