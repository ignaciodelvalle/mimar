-- ────────────────────────────────────────────────────────────────────────────
-- 0290_scheduling_provision_convergence.sql
-- Two follow-ups to 0288 (plan A6c): service_offerings joins the 0231 aal2
-- house rule, and a provisioned database stops diverging from a migrated one
-- on the scheduling policies.
--
-- 1. service_offerings — institutional sessions require aal2
-- ---------------------------------------------------------------------------
-- 0288 left "service_offerings read by org members" as the one scheduling
-- org-member branch without the restrictive aal2 policy, on the grounds that
-- authenticated holds SELECT on (id, organization_id, provider_user_id) only
-- (0279). That bound is the MIGRATED state's: scripts/deploy-provision.ts
-- step 5 (applySchemaGrants) re-grants SELECT on every public table to
-- authenticated after the replay, so on a provisioned database the same
-- branch hands an aal1 institutional member the whole row of their org's
-- offerings. The restrictive policy closes the branch whatever the grant.
--
-- Who it could break — inventory, 2026-10-07:
--   - PostgREST / user clients: none. No `.from("service_offerings")`, embed
--     or RPC in app/, lib/, src/, packages/ or apps/mobile/ (which talks to
--     the Next API). Every reader is Drizzle over the BYPASSRLS connection.
--   - Policies that sub-select service_offerings: the provider-vet and
--     org-member branches of appointments, service_schedule_rules and
--     time_slots — and nothing else in the catalog. A sub-select inside a
--     policy runs under the caller's RLS, so for an institutional aal1
--     caller those sub-selects now return nothing; each of the three tables
--     already denies that caller through its own 0288 restrictive policy, so
--     no outcome moves. Every caller that passes the helper (personal
--     accounts — owner, provider vet, personal member — and any aal2 session)
--     sees exactly what it saw.
--   - SECURITY DEFINER functions (erase_subject_data): bypass RLS, untouched.
-- The helper reads profiles, never service_offerings: no recursion.
--
-- 2. Provision convergence — the "0137 drift"
-- ---------------------------------------------------------------------------
-- 0137 wrapped auth.uid() as (select auth.uid()) in every flagged policy
-- (the initplan rewrite: same value, evaluated once per statement). It did so
-- with ALTER POLICY in the migration only; db/scheduling_rls.sql kept the
-- bare call, and deploy-provision applies that file AFTER the replay. Four
-- policies came out of a provision with different text than out of
-- db:migrate (measured by applying the file over a migrated database):
--   - service_offerings      "service_offerings read by provider vet"
--   - service_schedule_rules "schedule_rules read by provider vet"
--   - appointments           "appointments read by owner"
--   - appointments           "appointments read by provider vet"
-- (time_slots' provider-vet policy was rewritten wrapped by 0286.) Same
-- access either way; the provisioned plan re-evaluated auth.uid() per row.
-- Below, each is re-issued with the 0137 text and db/scheduling_rls.sql
-- carries the same statement byte-identical, so both paths land the same
-- pg_policies.qual. No predicate changes.
--
-- PROVISIONING: every `-- >>> scheduling_rls.sql mirror` block below appears
-- byte-identical in db/scheduling_rls.sql. Fence:
-- __tests__/rls/scheduling-provision-convergence.test.ts — it applies the
-- whole mirror inside a rolled-back transaction and asserts the scheduling
-- policies come out exactly as the migrations left them.
-- Forward-only and idempotent; the post-condition asks the catalog by SHAPE.
-- ────────────────────────────────────────────────────────────────────────────

-- >>> scheduling_rls.sql mirror: service_offerings provider vet (0290)
drop policy if exists "service_offerings read by provider vet" on public.service_offerings;
create policy "service_offerings read by provider vet"
  on public.service_offerings for select
  to authenticated
  using (provider_user_id = (select auth.uid()));
-- <<< scheduling_rls.sql mirror

-- >>> scheduling_rls.sql mirror: schedule_rules provider vet (0290)
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
-- <<< scheduling_rls.sql mirror

-- >>> scheduling_rls.sql mirror: appointments owner (0290)
drop policy if exists "appointments read by owner" on public.appointments;
create policy "appointments read by owner"
  on public.appointments for select
  to authenticated
  using (owner_user_id = (select auth.uid()));
-- <<< scheduling_rls.sql mirror

-- >>> scheduling_rls.sql mirror: appointments provider vet (0290)
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
-- <<< scheduling_rls.sql mirror

-- >>> scheduling_rls.sql mirror: service_offerings aal2 (0290)
drop policy if exists "institutional sessions require aal2" on public.service_offerings;
create policy "institutional sessions require aal2" on public.service_offerings
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));
-- <<< scheduling_rls.sql mirror

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'service_offerings'
       AND p.cmd = 'SELECT'
       AND p.permissive = 'RESTRICTIVE'
       AND p.roles = ARRAY['authenticated']::name[]
       AND coalesce(p.qual, '') LIKE '%caller_meets_institutional_aal()%'
  ) THEN
    RAISE EXCEPTION 'Migration 0290 did not close: no restrictive aal2 policy on service_offerings';
  END IF;

  -- No scheduling policy calls auth.uid() unwrapped (the 0137 initplan form
  -- deparses as "( SELECT auth.uid() AS uid)").
  SELECT string_agg(tablename || ': ' || policyname, '; ')
    INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('service_offerings', 'service_schedule_rules', 'time_slots', 'appointments')
     AND replace(coalesce(qual, '') || coalesce(with_check, ''), 'SELECT auth.uid() AS uid', '')
         LIKE '%auth.uid()%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0290 did not converge: bare auth.uid() in %', offenders;
  END IF;
END
$$;
