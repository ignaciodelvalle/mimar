-- Migration 0215 — an erased profile is not a platform administrator.
--
-- ORDER MATTERS: 0215 AND 0216 ARE NOT COMMUTATIVE. READ THIS FIRST.
-- ---------------------------------------------------------------------------
-- FIVE objects redefined below are ALSO redefined by migration 0216, which
-- amends their `govt` branches:
--
--   custody_disputes         "custody_disputes select by parties and authorities"
--   custody_dispute_parties  "custody_dispute_parties select by parties and authorities"
--   pet_service_dog          "service_dog select by owner or authority"
--   approval_requests        "approval requests visible to applicant or authority"
--   public.can_read_case(uuid, uuid)
--
-- The policy statements here use `ALTER POLICY ... USING (...)`, and that form
-- replaces the ENTIRE using clause — including the govt branch 0216 later
-- rewrites. `can_read_case` is a whole-body `CREATE OR REPLACE`, same effect.
-- So:
--
--   * On every environment these two must run strictly 0215, then 0216.
--   * Re-applying 0215 after 0216 has run SILENTLY REVERTS 0216. Nothing
--     errors; the govt branches simply lose their `deleted_at IS NULL` test
--     and an erased govt operator regains read authority.
--   * If 0215 is ever re-applied for any reason, 0216 MUST be re-applied
--     IN FULL immediately afterwards, in the same maintenance window.
--
-- This is not hypothetical. It happened on the local database on 2026-09-10
-- while amending the statement noted further down.
--
-- AND HERE IS THE PART THAT MATTERS MOST, because the first version of this
-- comment got it wrong and the mistake was the dangerous kind — it would have
-- sent the next person away believing they had cleaned up.
--
-- THE FENCE CANNOT SEE ALL FIVE. IT SEES THREE.
-- `scripts/check-rls-coverage.ts` check 5 matches `role = 'admin'` / `role =
-- 'govt'` tests against `profiles` and demands both lifecycle markers in the
-- same AND-group. On 2026-09-10 it named exactly three policies — and that was
-- read as "three reverted". It was not. It was "three are the ones this
-- instrument can express".
--
--   * `approval_requests`: 0215's govt branch authorises through
--     `govt_assignments`, never through `role = 'govt'` on `profiles`. There is
--     no pattern for check 5 to match, so its reversion is INVISIBLE — and that
--     reversion is precisely the hole 0216 §3 was written to close.
--   * `can_read_case`: check 5's live half does read function bodies, and
--     `scripts/check-function-parity.ts` compares `prosrc` against the last
--     defining migration, so this one is likelier to be caught — but nothing
--     guarantees it, and 0215's own DO block only asserts the admin branch.
--
-- So the recovery procedure is NOT "run the fence and fix what it names".
-- It is: RE-APPLY 0216 IN FULL, then run the fence as a confirmation that
-- cannot, on its own, prove absence. Widening check 5 to cover authorisation
-- through `govt_assignments` is open work, recorded here rather than done in
-- a migration.
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `profiles` carries two lifecycle markers that mean different things
-- (db/rls.sql, profiles section): a deactivation sets `deactivated_at`; a
-- Ley 25.326 art. 16 erasure (`erase_subject_data`, migration 0059 and its
-- successors) sets `deleted_at` and hashes every PII column. Both writes are
-- server-side only. Every predicate in the database that decides "is this
-- caller a platform admin" tested `deactivated_at` (or nothing) and NEVER
-- `deleted_at`. `erase_subject_data` sets only `deleted_at` — so an
-- administrator who exercised their OWN erasure kept administrative authority
-- at the RLS layer, including over the art. 14/16 access and erasure RPCs of
-- every other person: `pii.caller_is_admin` is the guard those RPCs call when
-- the caller is not the subject, and it had the same hole. The application
-- layer (requireLiveUser → ACCOUNT_ERASED) bounces an erased session off every
-- page, but a bearer token already issued keeps talking to PostgREST and to
-- the RPCs directly until it expires, and RLS is exactly the layer that is
-- supposed to hold when the application layer is bypassed.
--
-- INVENTORY (LOCAL catalog, taken before this migration was written)
-- ---------------------------------------------------------------------------
-- pg_policies (public + storage) and pg_proc (every app schema) were read for
-- every predicate testing `role = 'admin'` against `profiles`. Nineteen sites;
-- one already correct (`revocations_admin_govt_upload`, migration 0188 — it
-- checks both markers). The eighteen below — sixteen policies and two
-- functions — are redefined here. (The earlier wording said "eighteen sites,
-- seventeen redefined"; both numbers were off by one against the inventory
-- that follows, which lists 11 + 5 policies and 2 functions.) Every live
-- policy body already carried the `(select auth.uid())` initplan form from
-- migration 0137 — the db/*.sql bootstrap files still say bare `auth.uid()`,
-- and `can_read_case` live carries `SET search_path = ''` and the 0034
-- comments that db/cases_rls.sql dropped. Both drifts predate this migration
-- and are noted, not fixed: this migration rewrites the predicates and keeps
-- the initplan form and the pinned search_path.
--
--   policies checking deactivated_at, not deleted_at (11):
--     alert_subscriptions          "alert_subscriptions read by owner or admin"
--     ar_localities_import_runs    "ar_localities_import_runs select admin"
--     cron_runs                    "cron_runs select by admin"
--     custody_dispute_parties      "custody_dispute_parties select by parties and authorities"
--     custody_disputes             "custody_disputes select by parties and authorities"
--     foster_proposals             "Platform admins read all proposals"
--     foster_volunteers            "Platform admins read all volunteers"
--     org_contact_messages         "Platform admins read all org messages"
--     pet_identifications          "pet_identifications read by admin"
--     pet_service_dog              "service_dog select by owner or authority"
--     pet_transfers                "pet_transfers read by admin"
--   policies checking NEITHER marker (5):
--     approval_requests            "approval requests visible to applicant or authority"
--     audit_log                    "audit log visible to actor or admin"
--     govt_assignments             "govt sees own assignments"
--     welfare_report_attachments   "Admin can insert welfare attachments"
--     welfare_report_attachments   "Admin can read any welfare attachments"
--   functions (2):
--     public.can_read_case(uuid, uuid)   — deactivated_at only
--     pii.caller_is_admin(uuid)          — deactivated_at only
--
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
-- Every admin branch above gains `p.deleted_at IS NULL`. The five that checked
-- neither marker also gain `p.deactivated_at IS NULL`: a deactivated admin is
-- refused by every operator portal and every write boundary already
-- (lib/infra/auth-guards.ts), the app reads through Drizzle (BYPASSRLS) and
-- never through these policies, so the narrowing cannot lock the app out and
-- makes the seventeen predicates say the same thing.
--
-- Nothing else in any predicate moves. In particular:
--   · The `govt` branches of custody_disputes, custody_dispute_parties,
--     pet_service_dog and can_read_case are copied verbatim. They have the
--     same class of hole for an erased govt operator; that is a separate
--     subject with its own fence extension and its own behavioural test, not a
--     line smuggled into this one.
--   · `om.role = 'admin'` / `admin_m.role = 'admin'` on organization_memberships
--     (foster_volunteers "Org coordinators can read active pool",
--     organization_capability_grants "Admins can read all grants in their org")
--     is an ORGANIZATION membership role — a different concept from the
--     platform role, on a table that has no erasure marker. Out of scope.
--
-- ALTER POLICY replaces only the USING / WITH CHECK expression; command, roles
-- and kind are unchanged. CREATE OR REPLACE FUNCTION keeps each function's
-- ACL (0059's REVOKE FROM PUBLIC and 0174's REVOKE FROM authenticated on
-- pii.caller_is_admin survive; both are re-issued below anyway so the intent
-- is in this file too). Forward-only, transaction-safe, no data touched.
--
-- FENCES
-- ---------------------------------------------------------------------------
-- Static + live: scripts/check-rls-coverage.ts check 5 and
-- __tests__/check-rls-coverage.test.ts / __tests__/rls/coverage.test.ts — any
-- profile-level admin predicate in db/*.sql or in the live catalog without
-- BOTH markers is a violation. Behavioural: __tests__/rls/erased-admin-authority.test.ts.
-- Replay-time: the DO block at the end refuses to commit unless every object
-- named here actually carries `deleted_at IS NULL` in the catalog —
-- "aplicada" is not "cerrada".

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Policies that checked deactivated_at only → add deleted_at
-- ---------------------------------------------------------------------------

ALTER POLICY "alert_subscriptions read by owner or admin" ON public.alert_subscriptions
  USING (
    (actor_user_id = (select auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    ))
  );

ALTER POLICY "ar_localities_import_runs select admin" ON public.ar_localities_import_runs
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "cron_runs select by admin" ON public.cron_runs
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "custody_dispute_parties select by parties and authorities" ON public.custody_dispute_parties
  USING (
    (party_user_id = (select auth.uid()))
    OR (party_organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE (om.user_id = (select auth.uid())) AND (om.left_at IS NULL)
    ))
    OR (EXISTS (
      SELECT 1
      FROM public.custody_disputes cd
      JOIN public.profiles p ON (p.id = (select auth.uid()))
      WHERE (cd.id = custody_dispute_parties.dispute_id)
        AND (
          (
            (p.role = 'admin'::user_role)
            AND (p.account_type = 'institutional'::text)
            AND (p.deactivated_at IS NULL)
            AND (p.deleted_at IS NULL)
          )
          OR (
            (p.role = 'govt'::user_role)
            AND (EXISTS (
              SELECT 1 FROM public.govt_assignments g
              WHERE (g.user_id = p.id)
                AND (g.revoked_at IS NULL)
                AND (g.jurisdiction_province = cd.jurisdiction_province)
                AND (g.jurisdiction_locality = cd.jurisdiction_locality)
            ))
          )
        )
    ))
  );

ALTER POLICY "custody_disputes select by parties and authorities" ON public.custody_disputes
  USING (
    (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (
          (
            (p.role = 'admin'::user_role)
            AND (p.account_type = 'institutional'::text)
            AND (p.deactivated_at IS NULL)
            AND (p.deleted_at IS NULL)
          )
          OR (
            (p.role = 'govt'::user_role)
            AND (p.account_type = 'institutional'::text)
            AND (p.deactivated_at IS NULL)
            AND (EXISTS (
              SELECT 1 FROM public.govt_assignments g
              WHERE (g.user_id = p.id)
                AND (g.revoked_at IS NULL)
                AND (g.jurisdiction_province = custody_disputes.jurisdiction_province)
                AND (g.jurisdiction_locality = custody_disputes.jurisdiction_locality)
            ))
          )
        )
    ))
    OR (EXISTS (
      SELECT 1 FROM public.custody_dispute_parties cdp
      WHERE (cdp.dispute_id = custody_disputes.id)
        AND (
          (cdp.party_user_id = (select auth.uid()))
          OR (cdp.party_organization_id IN (
            SELECT om.organization_id FROM public.organization_memberships om
            WHERE (om.user_id = (select auth.uid())) AND (om.left_at IS NULL)
          ))
        )
    ))
  );

ALTER POLICY "Platform admins read all proposals" ON public.foster_proposals
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "Platform admins read all volunteers" ON public.foster_volunteers
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "Platform admins read all org messages" ON public.org_contact_messages
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

-- DROP + CREATE, not ALTER, and this is the one statement in the file that
-- needs it (amended 2026-09-10, before this migration had run anywhere but a
-- local database).
--
-- WHY. Every other policy here is ALTERed, which changes only the USING clause
-- and preserves cmd/roles/permissive — the right tool when the object is known
-- to exist. This one is NOT known to exist. Migration 0105 created it, and
-- staging's ledger says 0105 was applied; the catalog says otherwise. Measured
-- 2026-09-10 against staging: four policies that live only in migrations are
-- absent there — this one, "pet_identifications read by active owner", and the
-- two owner-write policies on `attachments` — while all 1284 structural objects
-- match. That environment was baselined at some point: the migrations were
-- marked applied without being run, and its schema came from the bootstrap
-- replay, which never carried these.
--
-- `pnpm db:drift` does not see this class of difference at all: it compares
-- columns, CHECK constraints, indexes and uniques, not policies. The drift that
-- mattered sat exactly where the detector does not look.
--
-- So the lesson is not "staging is broken", it is that A MIGRATION MUST NOT
-- BARE-ALTER AN OBJECT IT DID NOT CREATE. Restated as DROP + CREATE, this
-- statement carries the whole intended definition — the same idiom 0105 itself
-- uses — and lands the same result whether the policy is there or not. The
-- clause list (FOR SELECT, TO authenticated) is transcribed from 0105:79-91,
-- not invented, so an environment that DOES have the policy keeps its shape.
--
-- The other three absent policies are NOT repaired here: they are unrelated to
-- platform-admin erasure, and folding an incidental schema repair into a
-- security migration hides both. They get their own forward-only migration.
DROP POLICY IF EXISTS "pet_identifications read by admin" ON public.pet_identifications;
CREATE POLICY "pet_identifications read by admin"
  ON public.pet_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "service_dog select by owner or authority" ON public.pet_service_dog
  USING (
    (EXISTS (
      SELECT 1 FROM public.ownerships o
      WHERE (o.pet_id = pet_service_dog.pet_id)
        AND (o.owner_user_id = (select auth.uid()))
        AND (o.ended_at IS NULL)
    ))
    OR (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.account_type = 'institutional'::text)
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    ))
    OR (EXISTS (
      SELECT 1
      FROM public.pets pt
      JOIN public.profiles p ON (p.id = (select auth.uid()))
      WHERE (pt.id = pet_service_dog.pet_id)
        AND (p.account_type = 'institutional'::text)
        AND (p.role = 'govt'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (EXISTS (
          SELECT 1 FROM public.govt_assignments ga
          WHERE (ga.user_id = p.id)
            AND (ga.revoked_at IS NULL)
            AND (ga.jurisdiction_province = pt.jurisdiction_province)
            AND (ga.jurisdiction_locality = pt.jurisdiction_locality)
        ))
    ))
  );

ALTER POLICY "pet_transfers read by admin" ON public.pet_transfers
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Policies that checked neither marker → add both
-- ---------------------------------------------------------------------------

ALTER POLICY "approval requests visible to applicant or authority" ON public.approval_requests
  USING (
    (applicant_user_id = (select auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    ))
    OR (EXISTS (
      SELECT 1 FROM public.govt_assignments g
      WHERE (g.user_id = (select auth.uid()))
        AND (g.revoked_at IS NULL)
        AND (g.jurisdiction_province = approval_requests.jurisdiction_province)
        AND (g.jurisdiction_locality = approval_requests.jurisdiction_locality)
    ))
  );

ALTER POLICY "audit log visible to actor or admin" ON public.audit_log
  USING (
    (actor_user_id = (select auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    ))
  );

ALTER POLICY "govt sees own assignments" ON public.govt_assignments
  USING (
    (user_id = (select auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    ))
  );

ALTER POLICY "Admin can insert welfare attachments" ON public.welfare_report_attachments
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

ALTER POLICY "Admin can read any welfare attachments" ON public.welfare_report_attachments
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------

-- Body copied from the live catalog (0034 + the search_path pin), one line
-- changed. scripts/check-function-parity.ts now compares prosrc against THIS
-- file — keep the body byte-identical to what is applied.
create or replace function public.can_read_case(p_case_id uuid, p_user_id uuid)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
declare
  c record;
begin
  if p_case_id is null or p_user_id is null then
    return false;
  end if;

  select * into c from public.cases where id = p_case_id;
  if not found then
    return false;
  end if;

  -- Admin: universal scope. An erased profile (deleted_at, art. 16) is not an
  -- admin, and neither is a deactivated one — migration 0215.
  if exists (
    select 1 from public.profiles
    where id = p_user_id
      and role = 'admin'
      and deactivated_at is null
      and deleted_at is null
  ) then
    return true;
  end if;

  -- Govt: jurisdiction-scoped match against active govt_assignments. A
  -- govt user sees the case when (province, locality) match AT LEAST one
  -- of their assigned scopes.
  if exists (
    select 1
    from public.profiles p
    inner join public.govt_assignments ga on ga.user_id = p.id
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and ga.revoked_at is null
      and ga.jurisdiction_province = c.jurisdiction_province
      and ga.jurisdiction_locality = c.jurisdiction_locality
  ) then
    return true;
  end if;

  -- Subject-pet owner — except welfare_denuncia, where the owner is the
  -- subject of the investigation and must not see the case.
  if c.primary_pet_id is not null and exists (
    select 1
    from public.ownerships o
    where o.pet_id = c.primary_pet_id
      and o.ended_at is null
      and o.role = 'owner'
      and o.owner_user_id = p_user_id
  ) then
    if c.case_kind = 'welfare_denuncia' then
      return false;
    end if;
    return true;
  end if;

  -- Per-kind extensions.
  if c.case_kind = 'adoption_application' then
    return c.applicant_user_id = p_user_id;
  end if;

  if c.case_kind = 'adoption_listing' and c.opened_by_organization_id is not null then
    return exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.opened_by_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
    );
  end if;

  if c.case_kind = 'foster_placement' then
    -- (a) the active foster user, OR (b) members of the org that opened the case.
    if c.primary_pet_id is not null and exists (
      select 1 from public.ownerships o
      where o.pet_id = c.primary_pet_id
        and o.role = 'foster'
        and o.ended_at is null
        and o.owner_user_id = p_user_id
    ) then
      return true;
    end if;
    if c.opened_by_organization_id is not null and exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.opened_by_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
    ) then
      return true;
    end if;
    return false;
  end if;

  if c.case_kind = 'custody_dispute' and c.custody_dispute_id is not null then
    return exists (
      select 1 from public.custody_dispute_parties cdp
      where cdp.dispute_id = c.custody_dispute_id
        and (
          cdp.party_user_id = p_user_id
          or (cdp.party_organization_id is not null and cdp.party_organization_id in (
            select m.organization_id from public.organization_memberships m
            where m.user_id = p_user_id and m.left_at is null
          ))
        )
    );
  end if;

  -- bite_incident already covered above via subject-pet owner.
  -- lost_pet_episode: same.
  -- Anything else: deny.
  return false;
end;
$$;

-- The guard behind export_subject_data / erase_subject_data when the caller
-- is not the subject (0059). Same body, one marker added; search_path kept as
-- 0059 set it (the body qualifies public.profiles already).
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
  );
$$;

-- 0059 revoked PUBLIC, 0174 revoked authenticated. CREATE OR REPLACE keeps the
-- ACL; re-issued so this file states the grant posture it relies on.
REVOKE ALL ON FUNCTION pii.caller_is_admin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pii.caller_is_admin(uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Post-condition fence. ALTER POLICY / CREATE OR REPLACE by name report
-- success and change nothing when the live object was renamed or hand-patched
-- (0190, 0212 learned this). Ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
  expected constant text[] := ARRAY[
    'alert_subscriptions|alert_subscriptions read by owner or admin',
    'ar_localities_import_runs|ar_localities_import_runs select admin',
    'cron_runs|cron_runs select by admin',
    'custody_dispute_parties|custody_dispute_parties select by parties and authorities',
    'custody_disputes|custody_disputes select by parties and authorities',
    'foster_proposals|Platform admins read all proposals',
    'foster_volunteers|Platform admins read all volunteers',
    'org_contact_messages|Platform admins read all org messages',
    'pet_identifications|pet_identifications read by admin',
    'pet_service_dog|service_dog select by owner or authority',
    'pet_transfers|pet_transfers read by admin',
    'approval_requests|approval requests visible to applicant or authority',
    'audit_log|audit log visible to actor or admin',
    'govt_assignments|govt sees own assignments',
    'welfare_report_attachments|Admin can insert welfare attachments',
    'welfare_report_attachments|Admin can read any welfare attachments'
  ];
BEGIN
  -- (a) Every named policy exists AND carries both markers in its live text.
  SELECT string_agg(e, '; ')
    INTO offenders
  FROM unnest(expected) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = split_part(e, '|', 1)
      AND p.policyname = split_part(e, '|', 2)
      AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) LIKE '%deleted_at IS NULL%'
      AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) LIKE '%deactivated_at IS NULL%'
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0215 did not close: these policies are missing or still lack deleted_at/deactivated_at in the catalog (%). Inventory pg_policies by real name before retrying.',
      offenders;
  END IF;

  -- (b) Name-independent: NO policy in public/storage may test role = admin
  -- against profiles without deleted_at anywhere in its text. Coarse on
  -- purpose (the exact per-branch rule lives in scripts/check-rls-coverage.ts);
  -- it catches a renamed policy the list above cannot see.
  SELECT string_agg(format('%s.%s "%s"', p.schemaname, p.tablename, p.policyname), '; ')
    INTO offenders
  FROM pg_policies p
  WHERE p.schemaname IN ('public', 'storage')
    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) LIKE '%''admin''::user_role%'
    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) NOT LIKE '%deleted_at IS NULL%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0215 did not close: a policy still grants platform admin without deleted_at IS NULL (%).',
      offenders;
  END IF;

  -- (c) The two functions.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_read_case'
      AND p.prosrc LIKE '%and deleted_at is null%'
  ) THEN
    RAISE EXCEPTION 'Migration 0215 did not close: public.can_read_case still lacks deleted_at is null';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pii' AND p.proname = 'caller_is_admin'
      AND p.prosrc LIKE '%AND deleted_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'Migration 0215 did not close: pii.caller_is_admin still lacks deleted_at IS NULL';
  END IF;
END
$$;

COMMIT;
