-- ────────────────────────────────────────────────────────────────────────────
-- 0279_service_offerings_close_anon_read.sql
-- Service offerings stop exposing their provider, their reviewer and the
-- reason they were rejected to anyone holding the public anon key.
--
-- THE HOLE
-- ---------------------------------------------------------------------------
-- 0086 ported "service_offerings read approved publicly" from
-- db/scheduling_rls.sql: FOR SELECT TO anon, authenticated USING (status =
-- 'approved'). With Supabase's default table grants that is the WHOLE ROW of
-- every approved offering over GET /rest/v1/service_offerings: the provider's
-- profile id (provider_user_id), the admin who approved it
-- (reviewed_by_user_id, reviewed_at), rejection_reason and the internal
-- lifecycle columns. Same shape 0278 closed on organizations, found by the
-- anon read-surface check (check 6 of scripts/check-rls-coverage.ts) that
-- 0278 introduced, which froze this table as open debt.
--
-- WHO READS service_offerings THROUGH PostgREST (inventory, 2026-10-06)
-- ---------------------------------------------------------------------------
-- Nobody in the app. No `.from("service_offerings")`, no embedded select, no
-- RPC, no view, in app/, lib/, src/, apps/mobile/ (which talks to the Next
-- API, not to PostgREST) or packages/. The public org page's offerings
-- (lib/infra/org-public-offerings.ts), the owner search at /turnos/buscar,
-- booking, the org and /gob screens all read over Drizzle (BYPASSRLS).
-- erase_subject_data, the only function that touches the table, is SECURITY
-- DEFINER. The comment the public policy carried ("owners need to search
-- them") describes a PostgREST search that was never built.
--
-- The caller-role readers are POLICIES on other tables, all TO authenticated:
--   - appointments "appointments read by provider vet" and
--     service_schedule_rules "schedule_rules read by provider vet" sub-select
--     service_offerings.id WHERE provider_user_id = auth.uid();
--   - service_schedule_rules "schedule_rules read by org members"
--     sub-selects service_offerings.id WHERE organization_id IN (...).
-- A sub-select inside a policy runs with the caller's column privileges, so
-- authenticated keeps exactly those three columns.
--
-- WHICH COLUMNS ARE PUBLIC: none, through PostgREST
-- ---------------------------------------------------------------------------
-- The catalogue fields an owner sees (display_name, service_kind, price,
-- duration, eligibility, jurisdiction) are public on the PAGE, which renders
-- them server-side. No client reads them from the REST API, so granting them
-- would open a surface with no reader. A future client that needs them takes a
-- new migration with a column grant named for that reader.
--
-- THE FIX
-- ---------------------------------------------------------------------------
--   1. REVOKE ALL from PUBLIC, anon, authenticated. anon is left with nothing:
--      any anon read is a 42501.
--   2. GRANT SELECT (id, organization_id, provider_user_id) to authenticated —
--      what the three sub-selects above and this table's own policies read.
--   3. DROP the approved-publicly policy. authenticated reads only offerings
--      of its own organization or the ones it provides.
--   4. "service_offerings read by org members" goes through
--      public.caller_is_active_org_member (0273): its direct subquery on
--      organization_memberships re-entered that table's self-referential peers
--      policy, so EVERY authenticated read of service_offerings raised
--      infinite recursion (same defect 0278 repaired on organizations).
-- Not touched here, and still raising recursion for authenticated because
-- they sub-select organization_memberships themselves: "appointments read by
-- org members" and "schedule_rules read by org members". They read nothing
-- through PostgREST today; repairing them is their own migration.
--
-- Forward-only and idempotent. The post-condition asks the catalog by SHAPE,
-- not by policy name, so a hand-patched environment fails loudly instead of
-- reporting success. Reference snapshot: db/scheduling_rls.sql. Behavioural
-- fence: __tests__/rls/service-offerings-anon-read.test.ts. Catalog fence:
-- check 6 of scripts/check-rls-coverage.ts (service_offerings is no longer an
-- anon read surface, so it left ANON_READ_SURFACE).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. grants ------------------------------------------------------------------
REVOKE ALL ON public.service_offerings FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organization_id, provider_user_id) ON public.service_offerings TO authenticated;

-- 2. policies ----------------------------------------------------------------
ALTER TABLE public.service_offerings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_offerings read approved publicly" ON public.service_offerings;

DROP POLICY IF EXISTS "service_offerings read by org members" ON public.service_offerings;
CREATE POLICY "service_offerings read by org members"
  ON public.service_offerings
  FOR SELECT
  TO authenticated
  USING (public.caller_is_active_org_member(organization_id));

-- "service_offerings read by provider vet" (provider_user_id = auth.uid())
-- stays as 0137 left it.

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_offerings'::regclass) THEN
    RAISE EXCEPTION 'Migration 0279 did not close: RLS is not enabled on public.service_offerings';
  END IF;

  -- No table-level privilege of any kind for a caller role.
  SELECT string_agg(r || ':' || p, ', ') INTO offenders
    FROM unnest(ARRAY['anon', 'authenticated']) AS r
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.service_offerings', p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0279 did not close: table-level privileges survive on public.service_offerings (%)', offenders;
  END IF;

  -- Column privileges: anon none; authenticated SELECT on exactly
  -- (id, organization_id, provider_user_id).
  SELECT string_agg(r || ':' || a.attname || ':' || p, ', ') INTO offenders
    FROM pg_attribute a
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
   WHERE a.attrelid = 'public.service_offerings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(r, a.attrelid, a.attnum, p)
     AND NOT (r = 'authenticated' AND p = 'SELECT'
              AND a.attname IN ('id', 'organization_id', 'provider_user_id'));
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0279 did not close: column privileges beyond authenticated SELECT (id, organization_id, provider_user_id) on public.service_offerings: %', offenders;
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.service_offerings', 'id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.service_offerings', 'organization_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.service_offerings', 'provider_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 0279 over-corrected: authenticated lost a column the appointments / service_schedule_rules policies sub-select';
  END IF;

  -- Name-independent: every policy is a SELECT, none admits anon or PUBLIC,
  -- and none sub-selects organization_memberships directly (the recursion).
  SELECT string_agg(format('%s (%s, %s)', policyname, cmd, array_to_string(roles, '/')), '; ')
    INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'service_offerings'
     AND (cmd <> 'SELECT'
          OR roles && ARRAY['anon', 'public']::name[]
          OR coalesce(qual, '') LIKE '%organization_memberships%');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0279 did not close: unexpected policy on public.service_offerings (%). Inventory pg_policies and drop it by its real name before retrying.', offenders;
  END IF;

  -- The inverse mistake: providers and members keep their read paths.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'service_offerings'
         AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]) < 2 THEN
    RAISE EXCEPTION 'Migration 0279 over-corrected: the provider-vet and org-member SELECT policies on public.service_offerings must both survive';
  END IF;
END
$$;
