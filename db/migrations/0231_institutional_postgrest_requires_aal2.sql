-- Migration 0231 — an institutional session below aal2 has no authority at the
-- database layer either.
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- T2-S6 made every institutional principal (admin, govt, national) pass a TOTP
-- challenge before any portal or action. It enforced that in ONE place:
-- requireLiveUser, in the Next.js server. The database never heard of it. A
-- password alone, posted straight to GoTrue (`/auth/v1/token?grant_type=
-- password`), still mints a perfectly valid `aal1` access token, and PostgREST
-- honours that token exactly as it honoured every token before T2-S6:
--
--   · `export_subject_data` / `erase_subject_data` are granted to
--     `authenticated` and let a NON-subject caller through when
--     `pii.caller_is_admin(auth.uid())` says yes — which it did for any live
--     institutional admin, with no look at the assurance level. So a stolen
--     admin password was still a Ley 25.326 art. 14 dump, and an art. 16
--     erasure, of ANY person — the second factor protected neither.
--   · Eighteen tables grant institutional roles direct PostgREST reads (one
--     also an insert): the platform-admin branches 0215 hardened, the govt
--     branches 0216 hardened, and the case surface through can_read_case.
--
-- RLS is the layer that is supposed to hold when the application layer is
-- bypassed (AGENTS.md § Authorization architecture), and here it was the layer
-- that ignored the control.
--
-- THE FIX (Supabase's documented MFA pattern)
-- ---------------------------------------------------------------------------
-- 1. `public.caller_meets_institutional_aal()` — true unless the caller is a
--    LIVE institutional principal whose token is not `aal2`. "Institutional
--    principal" is the database twin of `isInstitutionalPrincipal`
--    (lib/infra/live-user.ts): account_type = 'institutional', or a platform
--    role (admin, govt, national) on any account type — the app asks those for
--    a second factor too. `aal` is read from `auth.jwt()`, i.e. from the claims
--    PostgREST verified; GoTrue signs it, a client cannot add it.
--
--    WHY "LIVE" (deleted_at / deactivated_at IS NULL). A deactivated or erased
--    profile holds no platform authority anywhere in this database (0215,
--    0216, fenced by scripts/check-rls-coverage.ts check 5). What it keeps is
--    exactly what a personal account keeps — rows that name it — so it is
--    judged as one. The markers are also what check 5 demands of any
--    `role IN ('admin', …)` test on profiles, and that rule is right here too.
--
-- 2. `pii.caller_is_admin` — the subject-rights guard — additionally requires
--    `aal2`. The SELF branch of both RPCs does not go through it and is
--    untouched: a citizen exporting or erasing their own data is aal1 by
--    nature and keeps working.
--
-- 3. A RESTRICTIVE policy on each of the eighteen tables, `TO authenticated`:
--    `USING ((select public.caller_meets_institutional_aal()))`. Restrictive
--    policies are AND-ed with every permissive one, so a single predicate
--    closes every institutional branch on the table — present and future —
--    without touching a single permissive predicate (and without re-opening
--    the 0215/0216 ordering hazard those predicates carry). SELECT on all
--    eighteen, because every institutional grant among them is a read; plus
--    INSERT on welfare_report_attachments, the one institutional write grant.
--    A personal account passes the predicate by construction, so citizens are
--    unaffected on every table.
--
-- INVENTORY (LOCAL catalog, 2026-09-18). Every pg_policies row in public and
-- storage whose text names a platform role literal, `institutional`,
-- `govt_assignments` or `can_read_case`, minus the two that test an
-- ORGANIZATION membership role (`om.role = 'admin'` on foster_volunteers "Org
-- coordinators can read active pool", organization_capability_grants "Admins
-- can read all grants in their org" — not a platform principal):
--
--   alert_subscriptions, approval_requests, ar_localities_import_runs,
--   attachments (can_read_case), audit_log, cases (can_read_case), cron_runs,
--   custody_dispute_parties, custody_disputes, foster_proposals,
--   foster_volunteers, govt_assignments, org_contact_messages, pet_events
--   (can_read_case), pet_identifications, pet_service_dog, pet_transfers,
--   welfare_report_attachments (SELECT + INSERT).
--
-- NOT COVERED, AND WHY
--   · storage.objects "revocations_admin_govt_upload" (INSERT into the
--     revocations bucket). A restrictive policy on storage.objects binds EVERY
--     bucket and every upload site, and the storage write fence
--     (scripts/check-storage-write-policies.ts) cannot yet parse `AS
--     RESTRICTIVE` in source. What an aal1 institutional token can do there is
--     drop an orphan file into a private bucket; the revocation record that
--     would reference it is a server action behind requireLiveUser (aal2).
--     Recorded as residual, not closed.
--   · `public.can_read_case(uuid, uuid)` stays EXECUTE-able as a bare RPC. It
--     answers a boolean for a case id the caller must already know; the rows
--     behind it (cases, pet_events, attachments) are covered by (3). Its body
--     is also the object 0215/0216 order-couple — not reopened for a boolean.
--
-- NOTHING IN THE APP MOVES. Every server read and write goes through Drizzle
-- on a BYPASSRLS connection; the only user-scoped PostgREST calls the web app
-- makes are the two subject-rights RPCs on the subject's OWN id (self branch)
-- and the revocations upload above. An institutional session reaching any of
-- them has passed requireLiveUser and is aal2 already.
--
-- FENCES
--   Behavioural: __tests__/rls/erased-admin-authority.test.ts (aal1 admin →
--   export/erase refused; aal1 govt → cases/audit_log denied; the same actors
--   at aal2 → allowed). Live coverage: __tests__/rls/coverage.test.ts derives
--   the institution-granting tables from the catalog and requires this
--   restrictive policy on each. Replay-time: the DO block below.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The predicate
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.caller_meets_institutional_aal() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      OR NOT EXISTS (
        SELECT 1 FROM public.profiles p
         WHERE p.id = auth.uid()
           AND (p.account_type = 'institutional' OR p.role IN ('admin', 'govt', 'national'))
           AND p.deleted_at IS NULL
           AND p.deactivated_at IS NULL
      );
$$;

COMMENT ON FUNCTION public.caller_meets_institutional_aal() IS
  'False only for a live institutional principal (account_type institutional, or role admin/govt/national) whose token is not aal2. Used by the restrictive "institutional sessions require aal2" policies (migration 0231).';

-- Policies run as the caller, so the caller must be able to execute it. It
-- answers only about the caller's own token and profile.
REVOKE ALL ON FUNCTION public.caller_meets_institutional_aal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.caller_meets_institutional_aal() FROM anon;
GRANT EXECUTE ON FUNCTION public.caller_meets_institutional_aal() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The subject-rights guard
-- ---------------------------------------------------------------------------

-- Same body as 0215 plus the assurance level. `auth.jwt()` is the CALLER's
-- token — which is the only caller this function is ever asked about
-- (export_subject_data / erase_subject_data pass auth.uid()).
CREATE OR REPLACE FUNCTION pii.caller_is_admin(p_caller_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_caller_id
       AND role = 'admin'
       AND account_type = 'institutional'
       AND deactivated_at IS NULL
       AND deleted_at IS NULL
  )
  AND coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

REVOKE ALL ON FUNCTION pii.caller_is_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pii.caller_is_admin(uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Restrictive policies
-- ---------------------------------------------------------------------------

CREATE POLICY "institutional sessions require aal2" ON public.alert_subscriptions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.approval_requests
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.ar_localities_import_runs
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.attachments
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.audit_log
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.cases
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.cron_runs
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.custody_dispute_parties
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.custody_disputes
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.foster_proposals
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.foster_volunteers
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.govt_assignments
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.org_contact_messages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.pet_events
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.pet_identifications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.pet_service_dog
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.pet_transfers
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2" ON public.welfare_report_attachments
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE POLICY "institutional sessions require aal2 to insert" ON public.welfare_report_attachments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((select public.caller_meets_institutional_aal()));

-- ---------------------------------------------------------------------------
-- Post-condition fence — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
  expected constant text[] := ARRAY[
    'alert_subscriptions|SELECT', 'approval_requests|SELECT',
    'ar_localities_import_runs|SELECT', 'attachments|SELECT', 'audit_log|SELECT',
    'cases|SELECT', 'cron_runs|SELECT', 'custody_dispute_parties|SELECT',
    'custody_disputes|SELECT', 'foster_proposals|SELECT', 'foster_volunteers|SELECT',
    'govt_assignments|SELECT', 'org_contact_messages|SELECT', 'pet_events|SELECT',
    'pet_identifications|SELECT', 'pet_service_dog|SELECT', 'pet_transfers|SELECT',
    'welfare_report_attachments|SELECT', 'welfare_report_attachments|INSERT'
  ];
BEGIN
  SELECT string_agg(e, '; ')
    INTO offenders
  FROM unnest(expected) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = split_part(e, '|', 1)
      AND p.cmd = split_part(e, '|', 2)
      AND p.permissive = 'RESTRICTIVE'
      AND p.roles = ARRAY['authenticated']::name[]
      AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
          LIKE '%caller_meets_institutional_aal()%'
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0231 did not close: no restrictive aal2 policy on %', offenders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pii' AND p.proname = 'caller_is_admin'
      AND p.prosrc LIKE '%''aal2''%'
  ) THEN
    RAISE EXCEPTION 'Migration 0231 did not close: pii.caller_is_admin does not require aal2';
  END IF;

  IF has_function_privilege('anon', 'public.caller_meets_institutional_aal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0231: anon can execute public.caller_meets_institutional_aal()';
  END IF;
END
$$;

COMMIT;
