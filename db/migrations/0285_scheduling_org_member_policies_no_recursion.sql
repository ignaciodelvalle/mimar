-- ────────────────────────────────────────────────────────────────────────────
-- 0285_scheduling_org_member_policies_no_recursion.sql
-- The org-member read policies on appointments and service_schedule_rules stop
-- recursing, with the same authorization they always declared.
--
-- THE DEFECT (security review 2026-10-06, plan A6-b)
-- ---------------------------------------------------------------------------
-- "appointments read by org members" and "schedule_rules read by org members"
-- (0086, initplan-wrapped by 0137) sub-select public.organization_memberships
-- directly. That table's "Members can read peers in same org" policy
-- sub-selects organization_memberships itself, so evaluating it re-enters the
-- same policy and Postgres raises 42P17 "infinite recursion detected in policy
-- for relation organization_memberships". Permissive policies are OR-ed and
-- all of them are planned, so the error is not confined to org members: EVERY
-- authenticated SELECT on either table raised — the owner reading their own
-- appointment and the provider vet reading their own rules included. Measured
-- on a freshly bootstrapped local stack before this file. 0279 named both
-- policies and left them for their own migration; this is it. Nothing in the
-- app reads these tables through PostgREST (booking, the agenda and the
-- owner's turnos all go through Drizzle, BYPASSRLS), which is why the error
-- never surfaced as a product bug.
--
-- THE FIX — same semantics, no subquery on organization_memberships
-- ---------------------------------------------------------------------------
-- Both policies ask public.caller_is_active_org_member(uuid) (0273): STABLE,
-- SECURITY DEFINER, empty search_path, EXECUTE for authenticated only, and it
-- answers only about auth.uid(). Its body is the old subquery's predicate —
-- an organization_memberships row with that organization_id, user_id =
-- auth.uid() and left_at IS NULL — evaluated without re-entering RLS:
--
--   appointments:
--     before  organization_id IN (SELECT organization_id FROM
--               organization_memberships WHERE user_id = auth.uid()
--               AND left_at IS NULL)
--     after   caller_is_active_org_member(organization_id)
--     Equal for every row, a NULL organization_id included (IN over a NULL
--     is NULL, the helper returns false: both deny). The caller's own
--     membership rows were always visible to it through "Members can read
--     their own memberships", so RLS on the old subquery filtered nothing.
--
--   service_schedule_rules:
--     before  service_offering_id IN (SELECT id FROM service_offerings
--               WHERE organization_id IN (<the membership subquery above>))
--     after   service_offering_id IN (SELECT id FROM service_offerings
--               WHERE caller_is_active_org_member(organization_id))
--     The outer sub-select on service_offerings is kept as it was, still
--     under that table's own RLS (which stopped recursing in 0279) and still
--     reading only id and organization_id — inside authenticated's 0279
--     column grant.
--
-- Untouched: the owner and provider-vet policies on both tables (they never
-- read organization_memberships), every grant, and the
-- organization_memberships peers policy itself (out of scope: it keeps
-- recursing for direct reads of that table, which nothing performs through
-- PostgREST; erased-admin-authority.test.ts records it).
--
-- PROVISIONING: db/scheduling_rls.sql, which scripts/deploy-provision.ts
-- applies AFTER the migration replay, carries these two statements
-- byte-identical, so a provision does not put the recursive bodies back.
-- __tests__/rls/scheduling-org-member-rls.test.ts pins both the behaviour and
-- that byte-identity.
--
-- Forward-only and idempotent. The post-condition asks the catalog by SHAPE.
-- ────────────────────────────────────────────────────────────────────────────

-- >>> scheduling_rls.sql mirror: appointments org members (0285)
drop policy if exists "appointments read by org members" on public.appointments;
create policy "appointments read by org members"
  on public.appointments for select
  to authenticated
  using (public.caller_is_active_org_member(organization_id));
-- <<< scheduling_rls.sql mirror

-- >>> scheduling_rls.sql mirror: schedule_rules org members (0285)
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
-- <<< scheduling_rls.sql mirror

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  -- No policy on either table sub-selects organization_memberships (the
  -- recursion), and none admits anon or PUBLIC.
  SELECT string_agg(format('%s.%s', tablename, policyname), ', ') INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('appointments', 'service_schedule_rules')
     AND (coalesce(qual, '') LIKE '%organization_memberships%'
          OR coalesce(with_check, '') LIKE '%organization_memberships%'
          OR roles && ARRAY['anon', 'public']::name[]);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0285 did not close: policy still sub-selects organization_memberships or admits anon (%). Inventory pg_policies and drop it by its real name before retrying.', offenders;
  END IF;

  -- The inverse mistake: each table keeps its three read paths (owner,
  -- org member, provider vet on appointments; org member, provider vet on
  -- service_schedule_rules), all SELECT TO authenticated.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'appointments'
         AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]) <> 3 THEN
    RAISE EXCEPTION 'Migration 0285: public.appointments must keep exactly its owner, org-member and provider-vet SELECT policies';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'service_schedule_rules'
         AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]) <> 2 THEN
    RAISE EXCEPTION 'Migration 0285: public.service_schedule_rules must keep exactly its org-member and provider-vet SELECT policies';
  END IF;

  -- The member branches go through the helper.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('appointments', 'service_schedule_rules')
         AND qual LIKE '%caller_is_active_org_member(%') <> 2 THEN
    RAISE EXCEPTION 'Migration 0285 did not close: the org-member policies on appointments / service_schedule_rules do not both call public.caller_is_active_org_member';
  END IF;
END
$$;
