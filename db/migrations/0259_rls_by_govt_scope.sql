-- Migration 0259 — the five govt SELECT policies and can_read_case read what a
-- govt user covers from public.govt_scope (localidades-por-id D8).
--
-- THE CHANGE
-- ---------------------------------------------------------------------------
-- 0241 left six predicates deciding govt access by comparing
-- govt_assignments.jurisdiction_locality with the row's jurisdiction_locality
-- AS STRINGS: Bragado's operator matched Alberti's Mechita. Stage D gives
-- "what does this operator cover?" one answer, public.govt_scope(user)
-- (0257), and this migration makes the RLS backstop read it:
--
--   source 'legacy'    a grant with authority_unit_id NULL. The predicate is
--                      0241's, VERBATIM in meaning: province equality, then
--                      the exact locality, the '' whole-province sentinel, or
--                      CABA's INDEC whole-city entry. A legacy grant admits
--                      exactly the rows it admitted before — nothing widens,
--                      nothing narrows (fenced by
--                      __tests__/rls/govt-whole-province-rls.test.ts, which
--                      evaluates the LIVE quals).
--   source 'province'  a grant on a provincial unit: every row of the
--                      province, including rows whose place never resolved.
--   source 'locality'  a grant on any other unit: a row whose catalogue
--                      locality_id is an ACTIVE member of the unit. A homonym
--                      in another partido or province is never a member, and
--                      a row with no locality_id never matches (P1/P3: an
--                      unresolved place reaches only its province).
--
-- Each grant is on ONE path (authority_unit_id NULL or set), never both.
--
-- Everything else in each definition is 0241's, unchanged: the profile tests
-- (role, institutional, deactivated_at, deleted_at — 0216), the
-- (select auth.uid()) initplan form (0137), the GOVT_DECIDABLE_TYPES filter on
-- approval_requests, the party / owner / applicant / admin branches, and
-- can_read_case's SECURITY DEFINER, `SET search_path = ''` and ACL. ALTER
-- POLICY replaces only the USING expression.
--
-- Rows the id path reads: custody_disputes.locality_id,
-- approval_requests.locality_id, pets.locality_id (for pet_identifications and
-- pet_service_dog) and cases.locality_id (0248 / 0147).
--
-- DEPLOY ORDER (design): apply to a remote database only AFTER the `scope`
-- flag has flipped there (the TS front door reads the same govt_scope). With
-- no grant on a unit — every grant until the partial-grant confirm flow runs —
-- this migration changes no answer at all.
--
-- ROLLBACK: a forward migration restoring 0241's six bodies verbatim.
--
-- FENCES
-- ---------------------------------------------------------------------------
-- Behavioural: __tests__/rls/govt-whole-province-rls.test.ts (legacy grants,
-- unchanged answers) and __tests__/rls/govt-unit-scope-rls.test.ts (unit
-- grants: isolation across the Mechita homonym, unresolved rows to the
-- province only). Replay-time: the DO block at the end asks the catalog.
--
-- Forward-only, transaction-safe, no data touched.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Policies (0241's bodies; the govt_assignments subquery replaced)
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
              SELECT 1 FROM public.govt_scope(p.id) s
              WHERE (
                ((s.source = 'legacy'::text)
                  AND (s.jurisdiction_province = custody_disputes.jurisdiction_province)
                  AND (
                    (s.jurisdiction_locality = custody_disputes.jurisdiction_locality)
                    OR (s.jurisdiction_locality = ''::text)
                    OR ((s.jurisdiction_province = 'CABA'::text)
                      AND (s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
                  ))
                OR ((s.source = 'province'::text)
                  AND (s.province_code = public.ar_province_code(custody_disputes.jurisdiction_province)))
                OR ((s.source = 'locality'::text)
                  AND (s.locality_id = custody_disputes.locality_id))
              )
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
          SELECT 1 FROM public.govt_scope(p.id) s
          WHERE (
            ((s.source = 'legacy'::text)
              AND (s.jurisdiction_province = pt.jurisdiction_province)
              AND (
                (s.jurisdiction_locality = pt.jurisdiction_locality)
                OR (s.jurisdiction_locality = ''::text)
                OR ((s.jurisdiction_province = 'CABA'::text)
                  AND (s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
              ))
            OR ((s.source = 'province'::text)
              AND (s.province_code = public.ar_province_code(pt.jurisdiction_province)))
            OR ((s.source = 'locality'::text)
              AND (s.locality_id = pt.locality_id))
          )
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
          SELECT 1 FROM public.govt_scope(p.id) s
          WHERE (
            ((s.source = 'legacy'::text)
              AND (s.jurisdiction_province = pt.jurisdiction_province)
              AND (
                (s.jurisdiction_locality = pt.jurisdiction_locality)
                OR (s.jurisdiction_locality = ''::text)
                OR ((s.jurisdiction_province = 'CABA'::text)
                  AND (s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
              ))
            OR ((s.source = 'province'::text)
              AND (s.province_code = public.ar_province_code(pt.jurisdiction_province)))
            OR ((s.source = 'locality'::text)
              AND (s.locality_id = pt.locality_id))
          )
        ))
    ))
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
            AND (p.deactivated_at IS NULL)
            AND (p.deleted_at IS NULL)
            AND (EXISTS (
              SELECT 1 FROM public.govt_scope(p.id) s
              WHERE (
                ((s.source = 'legacy'::text)
                  AND (s.jurisdiction_province = cd.jurisdiction_province)
                  AND (
                    (s.jurisdiction_locality = cd.jurisdiction_locality)
                    OR (s.jurisdiction_locality = ''::text)
                    OR ((s.jurisdiction_province = 'CABA'::text)
                      AND (s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
                  ))
                OR ((s.source = 'province'::text)
                  AND (s.province_code = public.ar_province_code(cd.jurisdiction_province)))
                OR ((s.source = 'locality'::text)
                  AND (s.locality_id = cd.locality_id))
              )
            ))
          )
        )
    ))
  );

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
      -- Only the types a govt operator may decide (GOVT_DECIDABLE_TYPES,
      -- lib/infra/approval-scope.ts), unchanged from 0241.
      AND (approval_requests.type IN ('role_upgrade_vet'::text, 'organization_verification'::text))
      AND (EXISTS (
        SELECT 1 FROM public.govt_scope((select auth.uid())) s
        WHERE (
          ((s.source = 'legacy'::text)
            AND (s.jurisdiction_province = approval_requests.jurisdiction_province)
            AND (
              (s.jurisdiction_locality = approval_requests.jurisdiction_locality)
              OR (s.jurisdiction_locality = ''::text)
              OR ((s.jurisdiction_province = 'CABA'::text)
                AND (s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
            ))
          OR ((s.source = 'province'::text)
            AND (s.province_code = public.ar_province_code(approval_requests.jurisdiction_province)))
          OR ((s.source = 'locality'::text)
            AND (s.locality_id = approval_requests.locality_id))
        )
      ))
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Function
-- ---------------------------------------------------------------------------

-- Body copied from 0241, only the govt branch changed.
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

  -- Govt: what the operator's ACTIVE grants cover, from public.govt_scope
  -- (localidades-por-id D8, migration 0259). A legacy grant (no authority
  -- unit) keeps 0241's name match, whole-province sentinel included; a
  -- provincial unit covers its province, unresolved cases included; any other
  -- unit covers its active member localities by id. An erased profile is not
  -- a govt operator either — migration 0216.
  if exists (
    select 1
    from public.profiles p
    cross join lateral public.govt_scope(p.id) s
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and p.deleted_at is null
      and (
        (s.source = 'legacy'
          and s.jurisdiction_province = c.jurisdiction_province
          and (
            s.jurisdiction_locality = c.jurisdiction_locality
            or s.jurisdiction_locality = ''
            or (s.jurisdiction_province = 'CABA'
              and s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires')
          ))
        or (s.source = 'province'
          and s.province_code = public.ar_province_code(c.jurisdiction_province))
        or (s.source = 'locality'
          and s.locality_id = c.locality_id)
      )
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
-- 3. Post-condition + inventory. ALTER POLICY / CREATE OR REPLACE by name
-- report success and change nothing when the live object was renamed or
-- hand-patched ("aplicada no es cerrada"). Ask the catalog.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
  -- table | policy | row alias inside the govt_scope subquery
  expected constant text[] := ARRAY[
    'approval_requests|approval requests visible to applicant or authority|approval_requests',
    'custody_dispute_parties|custody_dispute_parties select by parties and authorities|cd',
    'custody_disputes|custody_disputes select by parties and authorities|custody_disputes',
    'pet_identifications|pet_identifications read by govt in jurisdiction|pt',
    'pet_service_dog|service_dog select by owner or authority|pt'
  ];
BEGIN
  -- (a) Each policy exists, reads govt_scope after its govt role test, and
  -- carries the three branches keyed to its own row — whitespace-normalised
  -- so the check is about the predicate, not the deparser's line breaks.
  SELECT string_agg(split_part(e, '|', 1), '; ')
    INTO offenders
  FROM unnest(expected) AS e
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p,
         LATERAL (SELECT regexp_replace(coalesce(p.qual, ''), '\s+', ' ', 'g') AS q,
                         split_part(e, '|', 3) AS r) t,
         LATERAL (SELECT substring(t.q FROM position('''govt''::user_role' IN t.q)) AS tail) w
    WHERE p.schemaname = 'public'
      AND p.tablename = split_part(e, '|', 1)
      AND p.policyname = split_part(e, '|', 2)
      AND p.cmd = 'SELECT'
      AND position('govt_scope(' IN w.tail) > 0
      AND position(format('(s.jurisdiction_province = %s.jurisdiction_province)', t.r) IN w.tail) > 0
      AND position(format('(s.jurisdiction_locality = %s.jurisdiction_locality)', t.r) IN w.tail) > 0
      AND position('(s.jurisdiction_locality = ''''::text)' IN w.tail) > 0
      AND position('(s.jurisdiction_locality = ''Ciudad Autónoma de Buenos Aires''::text)' IN w.tail) > 0
      AND position(format('ar_province_code(%s.jurisdiction_province)', t.r) IN w.tail) > 0
      AND position(format('(s.locality_id = %s.locality_id)', t.r) IN w.tail) > 0
      AND position('(s.source = ''legacy''::text)' IN w.tail) > 0
      AND position('(s.source = ''province''::text)' IN w.tail) > 0
      AND position('(s.source = ''locality''::text)' IN w.tail) > 0
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0259 did not close: these policies are missing or do not read govt_scope with the three branches on their own row (%). Inventory pg_policies by real name before retrying.',
      offenders;
  END IF;

  -- (a2) approval_requests keeps the GOVT_DECIDABLE_TYPES filter before its
  -- govt_scope subquery.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies p,
         LATERAL (SELECT substring(p.qual FROM position('''govt''::user_role' IN p.qual)) AS tail) w
    WHERE p.schemaname = 'public'
      AND p.tablename = 'approval_requests'
      AND p.policyname = 'approval requests visible to applicant or authority'
      AND position('(type = ANY (ARRAY[''role_upgrade_vet''::text, ''organization_verification''::text]))' IN w.tail) > 0
      AND position('(type = ANY (ARRAY[''role_upgrade_vet''::text, ''organization_verification''::text]))' IN w.tail)
          < position('govt_scope(' IN w.tail)
  ) THEN
    RAISE EXCEPTION 'Migration 0259 did not close: the approval_requests govt branch lost the GOVT_DECIDABLE_TYPES filter';
  END IF;

  -- (b) Inventory: no public policy compares a govt_assignments locality NAME
  -- directly any more — every govt jurisdiction predicate goes through
  -- govt_scope. Catches a renamed or newly added policy the list cannot see.
  SELECT string_agg(format('%s "%s"', p.tablename, p.policyname), '; ')
    INTO offenders
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '\m(g|ga)\.jurisdiction_locality\M';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0259 did not close: a policy still compares govt_assignments locality names directly (%).',
      offenders;
  END IF;

  -- (c) The function: reads govt_scope with the three branches, no direct
  -- assignment comparison left, still SECURITY DEFINER with an empty
  -- search_path, 0216's marker kept.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_read_case'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
      AND p.prosrc LIKE '%and p.deleted_at is null%'
      AND p.prosrc LIKE '%public.govt_scope(p.id) s%'
      AND p.prosrc NOT LIKE '%ga.jurisdiction_locality%'
      AND regexp_replace(p.prosrc, '\s+', ' ', 'g') LIKE
        '%(s.source = ''legacy'' and s.jurisdiction_province = c.jurisdiction_province'
        ' and ( s.jurisdiction_locality = c.jurisdiction_locality'
        ' or s.jurisdiction_locality = '''''
        ' or (s.jurisdiction_province = ''CABA'''
        ' and s.jurisdiction_locality = ''Ciudad Autónoma de Buenos Aires'') ))'
        ' or (s.source = ''province'' and s.province_code = public.ar_province_code(c.jurisdiction_province))'
        ' or (s.source = ''locality'' and s.locality_id = c.locality_id)%'
  ) THEN
    RAISE EXCEPTION 'Migration 0259 did not close: public.can_read_case lacks the govt_scope branches, SECURITY DEFINER or search_path = ''''';
  END IF;
END
$$;

COMMIT;
