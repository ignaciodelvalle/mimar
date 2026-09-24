-- Migration 0216 — an erased profile is not a govt operator either.
--
-- THE DEFECT — the twin of 0215
-- ---------------------------------------------------------------------------
-- 0215 closed this for the platform ADMIN and said in its own header that the
-- `govt` branches were copied verbatim and left for "a separate subject with
-- its own fence extension and its own behavioural test". This is that subject.
--
-- `profiles` carries two lifecycle markers: `deactivated_at` (administrative
-- deactivation) and `deleted_at` (a Ley 25.326 art. 16 erasure, written by
-- `erase_subject_data`). Every predicate that decided "is this caller a govt
-- operator in this jurisdiction" tested `deactivated_at` — or nothing — and
-- never `deleted_at`. The deactivation path revokes the operator's
-- govt_assignments (deactivate-govt.ts, govt-self-deactivate.ts); the erasure
-- RPC does NOT touch govt_assignments. So an institutional govt account that
-- exercised its own erasure kept a live bearer token that still read
-- pet_service_dog, the chip/tattoo identifications of every pet in its
-- assigned jurisdiction and every approval request there — and, through
-- can_read_case, cases, pet_events and attachments for cases there. Read-only
-- and jurisdiction-scoped, so narrower than the admin hole, but the same
-- principle: an erasure must end the authority.
--
-- custody_disputes and custody_dispute_parties carried the same predicate hole
-- and are redefined here too, but were NOT actually readable through
-- PostgREST by an erased govt — or by anyone: both subquery
-- organization_memberships in their party branch, and that table's own SELECT
-- policy "Members can read peers in same org" (db/organizations_rls.sql,
-- 0086/0137) is self-referential, so the rewriter raises `infinite recursion
-- detected in policy for relation "organization_memberships"` on every
-- authenticated read of any of the three tables, before a row is looked at.
-- Found while writing the behavioural test for this migration (2026-09-09);
-- pre-existing and a separate subject. The predicate is fixed here anyway so
-- the day the recursion is fixed the govt branch is already right.
--
-- INVENTORY (LOCAL catalog, taken before this migration was written)
-- ---------------------------------------------------------------------------
-- pg_policies across EVERY schema and pg_proc across every app schema were
-- read for any text mentioning `govt` (the role literal and the
-- govt_assignments table both contain it, so this cannot miss a branch that
-- reaches govt authority either way). Seven policies and one function:
--
--   govt branch checking deactivated_at, not deleted_at (4):
--     custody_disputes          "custody_disputes select by parties and authorities"
--     pet_identifications       "pet_identifications read by govt in jurisdiction"
--     pet_service_dog           "service_dog select by owner or authority"
--     public.can_read_case(uuid, uuid)   — govt branch
--   govt branch checking NEITHER marker (1):
--     custody_dispute_parties   "custody_dispute_parties select by parties and authorities"
--   govt branch that never reads profiles at all (1):
--     approval_requests         "approval requests visible to applicant or authority"
--       — grants on an active govt_assignments row alone. Assignments are only
--       ever granted to an active institutional govt (assign-govt-locality.ts)
--       and are revoked on deactivation, so the ONLY caller that reaches this
--       branch without being a live govt is an erased one. 0214's `national`
--       role holds no assignments by design (its header says so).
--   already correct (1):
--     storage.objects           "revocations_admin_govt_upload" (0188 — both markers)
--   not authority (1):
--     govt_assignments          "govt sees own assignments" — user_id = auth.uid(),
--       a subject reading their own rows, no role test. Left alone.
--
-- Three functions mention `govt` in comments or strings only
-- (erase_subject_data, handle_new_user, enforce_institutional_no_pets) and one
-- trigger function (enforce_audit_log_append_only) never reads profiles.
--
-- File vs catalog: every live text above matches its last defining file —
-- 0215 for the four it carried, 0140 for pet_identifications. The two drifts
-- 0215 recorded (db/*.sql still say bare `auth.uid()`; db/cases_rls.sql lacks
-- can_read_case's `SET search_path = ''` and the 0034 comments) are unchanged
-- and still not fixed here.
--
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
-- Every govt branch above gains `p.deleted_at IS NULL`. The one that checked
-- neither marker (custody_dispute_parties) also gains `p.deactivated_at IS
-- NULL`, and the one that never read profiles (approval_requests) gains a
-- profiles test carrying role = 'govt' and both markers, ANDed with the
-- assignment test it already had. Same reasoning as 0215 §2: the app reads
-- through Drizzle (BYPASSRLS) and never through these policies, and every
-- operator portal refuses a deactivated govt already (lib/infra/auth-guards.ts),
-- so the narrowing cannot lock the app out.
--
-- Nothing else moves: the admin branches, the owner/party/organization
-- branches and the `(select auth.uid())` initplan form are copied verbatim.
-- ALTER POLICY replaces only the USING expression; command, roles and kind are
-- unchanged. CREATE OR REPLACE FUNCTION keeps can_read_case's ACL. Forward-only,
-- transaction-safe, no data touched.
--
-- FENCES
-- ---------------------------------------------------------------------------
-- Static + live: scripts/check-rls-coverage.ts check 5 now bans the subject
-- for BOTH roles — any `role = 'admin'` or `role = 'govt'` test on profiles, in
-- db/*.sql or in the live catalog, whose own AND-group lacks either marker.
-- Behavioural: __tests__/rls/erased-admin-authority.test.ts, govt half.
-- Replay-time: the DO block at the end asks the catalog, per branch, and
-- refuses to commit otherwise — "aplicada" is not "cerrada".

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Govt branches that checked deactivated_at only → add deleted_at
-- ---------------------------------------------------------------------------

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
            AND (p.deleted_at IS NULL)
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

ALTER POLICY "pet_identifications read by govt in jurisdiction" ON public.pet_identifications
  USING (
    EXISTS (
      SELECT 1
      FROM public.pets pt
        JOIN public.profiles p ON (p.id = (select auth.uid()))
      WHERE (pt.id = pet_identifications.pet_id)
        AND (p.role = 'govt'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
        AND (EXISTS (
          SELECT 1 FROM public.govt_assignments ga
          WHERE (ga.user_id = p.id)
            AND (ga.revoked_at IS NULL)
            AND (ga.jurisdiction_province = pt.jurisdiction_province)
            AND (ga.jurisdiction_locality = pt.jurisdiction_locality)
        ))
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
        AND (p.deleted_at IS NULL)
        AND (EXISTS (
          SELECT 1 FROM public.govt_assignments ga
          WHERE (ga.user_id = p.id)
            AND (ga.revoked_at IS NULL)
            AND (ga.jurisdiction_province = pt.jurisdiction_province)
            AND (ga.jurisdiction_locality = pt.jurisdiction_locality)
        ))
    ))
  );

-- ---------------------------------------------------------------------------
-- 2. Govt branch that checked neither marker → add both
-- ---------------------------------------------------------------------------

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
            AND (p.deactivated_at IS NULL)
            AND (p.deleted_at IS NULL)
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

-- ---------------------------------------------------------------------------
-- 3. Govt branch that never read profiles → the assignment alone is not an
--    operator; the profile behind it must be a live, non-erased govt.
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
    OR (
      (EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE (p.id = (select auth.uid()))
          AND (p.role = 'govt'::user_role)
          AND (p.deactivated_at IS NULL)
          AND (p.deleted_at IS NULL)
      ))
      AND (EXISTS (
        SELECT 1 FROM public.govt_assignments g
        WHERE (g.user_id = (select auth.uid()))
          AND (g.revoked_at IS NULL)
          AND (g.jurisdiction_province = approval_requests.jurisdiction_province)
          AND (g.jurisdiction_locality = approval_requests.jurisdiction_locality)
      ))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Function
-- ---------------------------------------------------------------------------

-- Body copied from the live catalog (0215), one line added in the govt branch.
-- scripts/check-function-parity.ts compares prosrc against the LAST defining
-- migration — this file now — so keep the body byte-identical to what is
-- applied.
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
  -- of their assigned scopes. An erased profile is not a govt operator
  -- either — migration 0216.
  if exists (
    select 1
    from public.profiles p
    inner join public.govt_assignments ga on ga.user_id = p.id
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and p.deleted_at is null
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

-- ---------------------------------------------------------------------------
-- Post-condition fence. ALTER POLICY / CREATE OR REPLACE by name report
-- success and change nothing when the live object was renamed or hand-patched
-- (0190, 0212 learned this). Ask the catalog what it actually holds — and ask
-- it PER BRANCH: every policy here also has an admin branch that has carried
-- both markers since 0215, so "the text contains deleted_at somewhere" would
-- have passed before this migration ran. The govt branch is the text from its
-- `'govt'::user_role` test up to its govt_assignments subquery; both markers
-- must sit inside that window.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
  expected constant text[] := ARRAY[
    'approval_requests|approval requests visible to applicant or authority',
    'custody_dispute_parties|custody_dispute_parties select by parties and authorities',
    'custody_disputes|custody_disputes select by parties and authorities',
    'pet_identifications|pet_identifications read by govt in jurisdiction',
    'pet_service_dog|service_dog select by owner or authority'
  ];
BEGIN
  -- (a) Every named policy exists AND its govt branch carries both markers.
  SELECT string_agg(e, '; ')
    INTO offenders
  FROM unnest(expected) AS e
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p,
         LATERAL (SELECT coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') AS text) t,
         LATERAL (SELECT substring(t.text FROM position('''govt''::user_role' IN t.text)) AS tail) w,
         LATERAL (SELECT position('govt_assignments' IN w.tail) AS ga,
                         position('deleted_at IS NULL' IN w.tail) AS del,
                         position('deactivated_at IS NULL' IN w.tail) AS dea) q
    WHERE p.schemaname = 'public'
      AND p.tablename = split_part(e, '|', 1)
      AND p.policyname = split_part(e, '|', 2)
      AND position('''govt''::user_role' IN t.text) > 0
      AND q.ga > 0
      AND q.del > 0 AND q.del < q.ga
      AND q.dea > 0 AND q.dea < q.ga
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0216 did not close: these policies are missing, or their govt branch still lacks deleted_at/deactivated_at in the catalog (%). Inventory pg_policies by real name before retrying.',
      offenders;
  END IF;

  -- (b) Name-independent: NO policy in public/storage may test role = govt
  -- against profiles without deleted_at IS NULL following that test before
  -- any govt_assignments subquery (or anywhere after it, when there is none).
  -- Catches a renamed policy the list above cannot see.
  SELECT string_agg(format('%s.%s "%s"', p.schemaname, p.tablename, p.policyname), '; ')
    INTO offenders
  FROM pg_policies p,
       LATERAL (SELECT coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') AS text) t,
       LATERAL (SELECT substring(t.text FROM position('''govt''::user_role' IN t.text)) AS tail) w,
       LATERAL (SELECT position('govt_assignments' IN w.tail) AS ga,
                       position('deleted_at IS NULL' IN w.tail) AS del) q
  WHERE p.schemaname IN ('public', 'storage')
    AND position('''govt''::user_role' IN t.text) > 0
    AND NOT (q.del > 0 AND (q.ga = 0 OR q.del < q.ga));
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0216 did not close: a policy still grants govt authority without deleted_at IS NULL (%).',
      offenders;
  END IF;

  -- (c) The function. The govt branch is the only aliased one in the body, so
  -- `p.deleted_at is null` names that branch and nothing else.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_read_case'
      AND p.prosrc LIKE '%and p.role = ''govt''%'
      AND p.prosrc LIKE '%and p.deleted_at is null%'
  ) THEN
    RAISE EXCEPTION 'Migration 0216 did not close: public.can_read_case govt branch still lacks p.deleted_at is null';
  END IF;
END
$$;

COMMIT;
