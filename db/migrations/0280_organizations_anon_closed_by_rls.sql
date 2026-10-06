-- ────────────────────────────────────────────────────────────────────────────
-- 0280_organizations_anon_closed_by_rls.sql
-- Anonymous callers are kept out of public.organizations by ROW LEVEL
-- SECURITY, not by a column grant. Corrects 0278.
--
-- WHAT 0278 GOT WRONG
-- ---------------------------------------------------------------------------
-- 0278 closed the full-row anon read of organizations by narrowing the GRANT
-- to SELECT (id, verified) and keeping an anon row policy, "Verified org ids
-- are publicly readable" (USING verified = true). Its header called the grant
-- "the fix" and its post-condition passed. Both claims hold only until the
-- next provision: scripts/deploy-provision.ts replays every migration and
-- THEN runs applySchemaGrants, whose `grant all on all tables in schema public
-- to anon, authenticated, service_role` restores the table-level SELECT. With
-- the anon row policy still in place, a freshly provisioned database serves
-- the whole row of every verified organization again. The 0278 post-condition
-- cannot see this: it runs inside the replay, before the re-grant.
-- docs/architecture/authorization.md already records the rule ("a column
-- REVOKE was NOT the fix ... re-grants ALL on every provision"); 0278 broke
-- it. 0278 is immutable, so the correction is recorded here.
--
-- 0279 (service_offerings) is NOT affected: it dropped the only policy that
-- admitted anon, so a re-granted SELECT still reaches zero rows.
--
-- THE FIX: no row policy admits anon on organizations
-- ---------------------------------------------------------------------------
-- RLS is evaluated after grants, whatever the grants are. With no policy that
-- admits anon (or PUBLIC), anon reads zero rows of organizations even holding
-- table-level SELECT. Also dropped for authenticated: "Verified org ids are
-- publicly readable" was TO anon, authenticated, and under a re-granted SELECT
-- it would hand every logged-in account the whole row of every verified org.
-- What stays on organizations is the member policy exactly as 0278 left it
-- (caller_is_active_org_member(id)).
--
-- The one caller-role reader that needed the anon row policy was the
-- organization_coverage policy, which sub-selected organizations. It now asks
-- public.org_is_verified(organization_id): a STABLE SECURITY DEFINER helper
-- with an empty search_path, the 0273 pattern. It is anon-executable on
-- purpose — the coverage policy is TO anon, authenticated — and it answers
-- only "is this organization id verified", which the anon-readable coverage
-- rows already disclose (they exist for verified parents only). It is the
-- first entry of ANON_EXECUTE_ALLOWED in __tests__/rls/function-hardening.test.ts.
--
-- The 0278 column grant (SELECT (id, verified) to anon, authenticated) is left
-- alone: harmless, and no longer load-bearing for anything.
--
-- PROVISIONING: deploy-provision.ts now runs the anon read-surface check
-- (check 6 of scripts/check-rls-coverage.ts) in its post-provision
-- verification, after the re-grant, and fails the provision on an undeclared
-- anon surface or on anon columns beyond a declaration. db/organizations_rls.sql,
-- which the provisioner also applies after the replay, no longer recreates the
-- anon policy.
--
-- Forward-only and idempotent. The post-condition asks the catalog by SHAPE.
-- Behavioural fence: __tests__/rls/organizations-anon-read.test.ts.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. helper ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.org_is_verified(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organizations o
     WHERE o.id = p_organization_id
       AND o.verified = true
  );
$$;

COMMENT ON FUNCTION public.org_is_verified(uuid) IS
  'True when the organization exists and is verified. Backs the anon-readable organization_coverage policy so that no row policy on organizations has to admit anon (migration 0280). Discloses nothing the coverage rows do not.';

REVOKE EXECUTE ON FUNCTION public.org_is_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_is_verified(uuid) TO anon, authenticated, service_role;

-- 2. organization_coverage: stop sub-selecting organizations -------------------
DROP POLICY IF EXISTS "Coverage readable when parent org is verified" ON public.organization_coverage;
CREATE POLICY "Coverage readable when parent org is verified"
  ON public.organization_coverage
  FOR SELECT
  TO anon, authenticated
  USING (public.org_is_verified(organization_id));

-- 3. organizations: no row policy admits anon ---------------------------------
DROP POLICY IF EXISTS "Verified org ids are publicly readable" ON public.organizations;
DROP POLICY IF EXISTS "Verified orgs are publicly readable" ON public.organizations;

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'Migration 0280 did not close: RLS is not enabled on public.organizations';
  END IF;

  -- By shape: no policy on organizations admits anon or PUBLIC, and every
  -- remaining policy is the member-only SELECT through the 0273 helper — so a
  -- re-granted table SELECT reaches no row for a non-member.
  SELECT string_agg(format('%s (%s, %s)', policyname, cmd, array_to_string(roles, '/')), '; ')
    INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organizations'
     AND (cmd <> 'SELECT'
          OR roles && ARRAY['anon', 'public']::name[]
          OR coalesce(qual, '') NOT LIKE '%caller_is_active_org_member(%');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0280 did not close: policy on public.organizations that is not member-only (%). Inventory pg_policies and drop it by its real name before retrying.', offenders;
  END IF;

  -- The coverage policies no longer read the organizations table.
  SELECT string_agg(policyname, ', ') INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'organization_coverage'
     AND (coalesce(qual, '') ~ '\morganizations\M'
          OR coalesce(with_check, '') ~ '\morganizations\M');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0280 did not close: organization_coverage policies still sub-select organizations (%)', offenders;
  END IF;

  -- The inverse mistake: the coverage read path survives, through the helper.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_coverage'
       AND cmd = 'SELECT' AND roles @> ARRAY['anon', 'authenticated']::name[]
       AND coalesce(qual, '') LIKE '%org_is_verified(%'
  ) THEN
    RAISE EXCEPTION 'Migration 0280 over-corrected: no anon-readable coverage policy through org_is_verified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'org_is_verified'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=""']
  ) OR NOT has_function_privilege('anon', 'public.org_is_verified(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0280 did not close: org_is_verified must be SECURITY DEFINER, pin search_path and be executable by anon';
  END IF;
END
$$;
