-- ────────────────────────────────────────────────────────────────────────────
-- 0288_scheduling_institutional_aal2.sql
-- appointments, service_schedule_rules and time_slots join the 0231 house
-- rule: an institutional session below aal2 reads none of them through
-- PostgREST.
--
-- THE HOLE (plan A6b)
-- ---------------------------------------------------------------------------
-- Until 0285 every authenticated SELECT on appointments and
-- service_schedule_rules raised 42P17 (the organization_memberships peers
-- recursion), and until 0286 time_slots had no org-member branch at all. 0285
-- and 0286 gave the three tables a working "read by org members" policy
-- through public.caller_is_active_org_member — and none of the three carries
-- the restrictive aal2 policy 0231 put on every institution-granting table.
-- So an ACTIVE member of an organization whose profile is
-- account_type = 'institutional' could post a password to GoTrue, receive an
-- aal1 token, and read over GET /rest/v1/ their organization's appointments
-- (pet, owner, slot), schedule rules and slot occupancy — the second factor
-- the app demands of that account (requireLiveUser) protected none of it.
-- __tests__/rls/coverage.test.ts did not catch it: its granting set is the
-- tables whose policies name a PLATFORM role, and an org-membership branch
-- names none.
--
-- THE FIX — the 0231 shape, verbatim
-- ---------------------------------------------------------------------------
-- One RESTRICTIVE policy per table, FOR SELECT TO authenticated, USING
-- ((select public.caller_meets_institutional_aal())). It is AND-ed with every
-- permissive policy on the table, so it closes the org-member branch and any
-- institutional branch added later, without touching a permissive predicate.
-- The helper (0231) is false ONLY for a live profile with account_type
-- 'institutional' or role admin / govt / national whose token is not aal2;
-- every other caller passes it by construction:
--   - the owner reading their own appointment (personal account) — unaffected;
--   - the independent provider vet (personal account, role 'vet') — unaffected;
--   - a personal-account org member — unaffected (the institutional-account
--     rule is the account type's, not the membership's);
--   - an institutional member at aal2 — unaffected, the legitimate path.
-- SELECT only: no policy on these tables grants authenticated a write, and
-- the writes are Drizzle server actions (BYPASSRLS) behind requireLiveUser.
--
-- NOTHING IN THE APP MOVES. No `.from("appointments" | "service_schedule_rules"
-- | "time_slots")` exists in the web app or the mobile client (0286
-- inventory); every reader is Drizzle over the BYPASSRLS connection.
--
-- NOT COVERED: service_offerings carries the same org-member branch, but
-- authenticated holds SELECT on (id, organization_id, provider_user_id) only
-- since 0279 — the ids the three policies above sub-select. Restricting it
-- would also narrow those sub-selects for the caller, which the restrictive
-- policies here already decide. Recorded as residual.
--
-- PROVISIONING: db/scheduling_rls.sql, which scripts/deploy-provision.ts
-- applies AFTER the migration replay, carries the block below
-- byte-identical. Behavioural fence: __tests__/rls/scheduling-aal2.test.ts.
-- Forward-only and idempotent; the post-condition asks the catalog by SHAPE.
-- ────────────────────────────────────────────────────────────────────────────

-- >>> scheduling_rls.sql mirror: institutional aal2 (0288)
drop policy if exists "institutional sessions require aal2" on public.service_schedule_rules;
create policy "institutional sessions require aal2" on public.service_schedule_rules
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));

drop policy if exists "institutional sessions require aal2" on public.time_slots;
create policy "institutional sessions require aal2" on public.time_slots
  as restrictive for select to authenticated
  using ((select public.caller_meets_institutional_aal()));

drop policy if exists "institutional sessions require aal2" on public.appointments;
create policy "institutional sessions require aal2" on public.appointments
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
  SELECT string_agg(t, '; ')
    INTO offenders
    FROM unnest(ARRAY['appointments', 'service_schedule_rules', 'time_slots']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = t
        AND p.cmd = 'SELECT'
        AND p.permissive = 'RESTRICTIVE'
        AND p.roles = ARRAY['authenticated']::name[]
        AND coalesce(p.qual, '') LIKE '%caller_meets_institutional_aal()%'
   );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0288 did not close: no restrictive aal2 policy on %', offenders;
  END IF;

  IF has_function_privilege('anon', 'public.caller_meets_institutional_aal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0288: anon can execute public.caller_meets_institutional_aal()';
  END IF;
END
$$;
