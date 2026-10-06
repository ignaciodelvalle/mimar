-- ────────────────────────────────────────────────────────────────────────────
-- 0278_organizations_close_anon_read.sql
-- Verified organizations stop exposing their contact details and location to
-- anyone holding the public anon key.
--
-- THE HOLE
-- ---------------------------------------------------------------------------
-- 0086 ported "Verified orgs are publicly readable" from db/organizations_rls.sql:
-- FOR SELECT TO anon, authenticated USING (verified = true). Supabase grants
-- anon and authenticated every table privilege on a new public table, so the
-- policy handed the WHOLE ROW of every verified organization to
-- GET /rest/v1/organizations?select=* with nothing but the publishable key:
-- email, phone, cuit, personeria_juridica_number, website, location_lat /
-- location_lng — the coordinates even when disclose_address = false, which is
-- the org's own "do not show where we are" switch. A small rescue run from a
-- home is a person's home address.
--
-- WHO READS organizations THROUGH PostgREST (inventory, 2026-10-06)
-- ---------------------------------------------------------------------------
-- Nobody in the app. No `.from("organizations")`, no embedded
-- `organizations(...)` select, no RPC and no view over it in app/, lib/, src/,
-- apps/mobile/ or packages/. Every org read — the public profile, the
-- directory, the sitemap, tier-0 branding — goes through Drizzle (BYPASSRLS)
-- or the service role, which this migration does not touch. The one
-- caller-role reader is a POLICY: "Coverage readable when parent org is
-- verified" on organization_coverage sub-selects `organizations o` for
-- `o.id` and `o.verified`, as anon and as authenticated. No function reads
-- organizations except erase_subject_data, which is SECURITY DEFINER.
--
-- THE FIX: a column grant, not a row filter
-- ---------------------------------------------------------------------------
-- A policy chooses ROWS; it cannot hide columns. So the surface is cut where
-- columns are decided — the grant:
--   1. REVOKE ALL on organizations from PUBLIC, anon, authenticated. That
--      removes the table-level SELECT (and the INSERT / UPDATE / DELETE /
--      TRUNCATE / REFERENCES / TRIGGER grants nothing needed: RLS gated the
--      writes, but TRUNCATE is not subject to RLS at all).
--   2. GRANT SELECT (id, verified) to anon and authenticated — exactly the two
--      columns the coverage policy's sub-select reads, so it keeps working for
--      both roles. A column added later (0277's public_directory_opt_in, or
--      anything after it) gets NO caller-role grant, because there is no
--      table-level grant left for it to inherit.
--   3. The broad policy is replaced by "Verified org ids are publicly
--      readable" — same predicate, but what it can return is now (id,
--      verified) and nothing else. `select=*` as anon is a 42501.
--
-- THE MEMBER POLICIES WERE ALREADY DEAD, AND ARE REPAIRED HERE
-- ---------------------------------------------------------------------------
-- "Members can read their own org" (organizations) and "Members can read
-- their org coverage" (organization_coverage) sub-select
-- organization_memberships as `authenticated`, which re-enters that table's
-- self-referential peers policy: EVERY authenticated read of organizations or
-- organization_coverage raised `infinite recursion detected in policy for
-- relation "organization_memberships"` (measured on the local stack
-- 2026-10-06). That also broke the coverage policy above for authenticated.
-- Both are redefined through public.caller_is_active_org_member (0273), the
-- caller-only SECURITY DEFINER helper that exists for exactly this. A member
-- reads their own org's (id, verified) — the column grant holds for them too;
-- the refugio portal reads its org over Drizzle. Widening a member's PostgREST
-- read takes a new migration that argues for it.
--
-- organization_coverage keeps its SELECT grant (jurisdiction rows, no personal
-- data) and loses the write grants it never used.
--
-- Forward-only and idempotent: DROP POLICY IF EXISTS / REVOKE / GRANT are
-- no-ops on re-run. "Applied" is not "closed": a DROP POLICY by name says OK
-- and does nothing on an environment that was hand-patched under another
-- name, so the post-condition block asks the catalog by SHAPE, not by name.
-- Reference snapshot: db/organizations_rls.sql. Behavioural fence:
-- __tests__/rls/organizations-anon-read.test.ts. Catalog fence: check 6 of
-- scripts/check-rls-coverage.ts (pnpm lint:rls).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. organizations: grants ---------------------------------------------------
REVOKE ALL ON public.organizations FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, verified) ON public.organizations TO anon, authenticated;

-- 2. organizations: policies -------------------------------------------------
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Verified orgs are publicly readable" ON public.organizations;
DROP POLICY IF EXISTS "Verified org ids are publicly readable" ON public.organizations;
CREATE POLICY "Verified org ids are publicly readable"
  ON public.organizations
  FOR SELECT
  TO anon, authenticated
  USING (verified = true);

DROP POLICY IF EXISTS "Members can read their own org" ON public.organizations;
CREATE POLICY "Members can read their own org"
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (public.caller_is_active_org_member(id));

-- 3. organization_coverage ----------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.organization_coverage FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Members can read their org coverage" ON public.organization_coverage;
CREATE POLICY "Members can read their org coverage"
  ON public.organization_coverage
  FOR SELECT
  TO authenticated
  USING (public.caller_is_active_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  offenders text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'Migration 0278 did not close: RLS is not enabled on public.organizations';
  END IF;

  -- No table-level privilege of any kind for a caller role.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    SELECT string_agg(p, ', ') INTO offenders
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
     WHERE has_table_privilege(r, 'public.organizations', p);
    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION 'Migration 0278 did not close: % still holds table-level % on public.organizations', r, offenders;
    END IF;

    -- Column privileges: SELECT on exactly (id, verified); nothing else on any column.
    SELECT string_agg(a.attname || ':' || p, ', ') INTO offenders
      FROM pg_attribute a
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
     WHERE a.attrelid = 'public.organizations'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND has_column_privilege(r, a.attrelid, a.attnum, p)
       AND NOT (p = 'SELECT' AND a.attname IN ('id', 'verified'));
    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION 'Migration 0278 did not close: % holds column privileges beyond SELECT (id, verified) on public.organizations: %', r, offenders;
    END IF;

    IF NOT has_column_privilege(r, 'public.organizations', 'id', 'SELECT')
       OR NOT has_column_privilege(r, 'public.organizations', 'verified', 'SELECT') THEN
      RAISE EXCEPTION 'Migration 0278 over-corrected: % lost SELECT (id, verified) on public.organizations, which the organization_coverage policy reads', r;
    END IF;
  END LOOP;

  -- Name-independent: every policy on organizations is a SELECT, and the only
  -- one that admits anon (or PUBLIC) is the new verified-ids policy.
  SELECT string_agg(format('%s (%s, %s)', policyname, cmd, array_to_string(roles, '/')), '; ')
    INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organizations'
     AND (cmd <> 'SELECT'
          OR (roles && ARRAY['anon', 'public']::name[]
              AND policyname <> 'Verified org ids are publicly readable'));
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0278 did not close: unexpected policy on public.organizations (%). Inventory pg_policies and drop it by its real name before retrying.', offenders;
  END IF;

  -- The member policies must not sub-select organization_memberships directly
  -- (that is the recursion this migration repairs).
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('organizations', 'organization_coverage')
     AND coalesce(qual, '') LIKE '%organization_memberships%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0278 did not close: % still sub-select organization_memberships (recursive peers policy)', offenders;
  END IF;

  -- The inverse mistake: the coverage read path must survive.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_coverage'
       AND cmd = 'SELECT' AND roles @> ARRAY['anon', 'authenticated']::name[]
  ) OR NOT has_table_privilege('anon', 'public.organization_coverage', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 0278 over-corrected: organization_coverage is no longer readable for verified orgs';
  END IF;

  SELECT string_agg(r2 || ':' || p, ', ') INTO offenders
    FROM unnest(ARRAY['anon', 'authenticated']) AS r2
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
   WHERE has_table_privilege(r2, 'public.organization_coverage', p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0278 did not close: write grants survive on public.organization_coverage (%)', offenders;
  END IF;
END
$$;
