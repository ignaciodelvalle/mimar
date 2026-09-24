-- Migration 0241 — a whole-province govt assignment reaches the whole province
-- through RLS too (T3-J1b, PO decision 7C 2026-09-22).
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- Five SELECT policies and the SECURITY DEFINER function can_read_case decide
-- govt access by comparing govt_assignments.jurisdiction_locality with the
-- row's jurisdiction_locality AS STRINGS (inventory:
-- docs/architecture/locality-name-match-inventory.md, T3-J1). None of the six
-- had a whole-province branch. A govt operator assigned "toda la provincia"
-- matched no row through RLS, while the TypeScript gate treats that same
-- assignment as the whole province. The two layers disagreed about what
-- "toda la provincia" means — in the DENYING direction: the operator lost
-- access, nobody gained any.
--
-- THE SEMANTICS MIRRORED — exactly, and no wider
-- ---------------------------------------------------------------------------
-- Source: lib/domain/jurisdiction-canonical.ts — isWholeProvinceLocality(),
-- consumed by jurisdictionPairClause (lib/metrics/scope.ts),
-- jurisdictionScopeContains and visibleRequestsClause
-- (lib/infra/approval-scope.ts). An assignment (province, locality) is
-- WHOLE-PROVINCE when, and only when:
--   · locality is the empty-string sentinel '' (any canonical province, D3
--     2026-08-04), or
--   · province = 'CABA' and locality = 'Ciudad Autónoma de Buenos Aires'
--     (INDEC's single whole-city entry; the only province with one).
-- A whole-province assignment then matches on PROVINCE ALONE — including a
-- row whose locality is NULL, exactly like the TS clause. Every other
-- assignment keeps the exact (province, locality) pair.
--
-- What deliberately does NOT widen, same as the TS predicate:
--   · the province's own name is NOT the sentinel ("Mendoza", "Córdoba",
--     "Salta", "Santa Fe" are real localities); an assignment (Mendoza,
--     "Mendoza") stays a capital-city assignment;
--   · province equality is always kept, so a whole-province operator never
--     sees another province;
--   · only an ACTIVE assignment counts — the existing `revoked_at IS NULL`
--     test is untouched and still ANDed with the new branch;
--   · TS also refuses a non-canonical province; here the column is NOT NULL
--     and CHECK-constrained to the 24 canonical names
--     (govt_assignments_jurisdiction_province_canonical), so the same refusal
--     holds without repeating the list.
--
-- Government authority stays NAME-based for the pilot (PO 7C). The authority
-- unit registry that would retire these name comparisons is cutover debt
-- (L4·2). This migration adds a branch to an existing name comparison; it
-- does not add a new one.
--
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
-- Each definition is copied verbatim from its latest defining migration (0216
-- for all six) and ONLY the locality predicate changes:
--     (g.jurisdiction_locality = <row>.jurisdiction_locality)
-- becomes
--     ((g.jurisdiction_locality = <row>.jurisdiction_locality)
--      OR (g.jurisdiction_locality = '')
--      OR (g.jurisdiction_province = 'CABA'
--          AND g.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'))
-- One more narrowing, on approval_requests only: its govt branch had no type
-- predicate, while the TS queue (visibleRequestsClause) shows govt only
-- GOVT_DECIDABLE_TYPES. Widening the locality without it would have let a
-- whole-province operator read every service-dog credential request in the
-- province (fresh-context security review, 2026-09-22). The govt branch now
-- carries the same type list; the applicant and admin branches are unchanged.
-- The (select auth.uid()) initplan form (0137), both lifecycle markers (0216),
-- can_read_case's SECURITY DEFINER, `SET search_path = ''` and ACL are kept.
-- ALTER POLICY replaces only the USING expression. erase_subject_data is NOT
-- touched: it writes the column, it does not compare it.
--
-- Where this bites: only the PostgREST surface goes through these predicates
-- (the application reads with BYPASSRLS behind the TS gates). It is the
-- backstop, made to agree with the front door.
--
-- FENCES
-- ---------------------------------------------------------------------------
-- Behavioural: __tests__/rls/govt-whole-province-rls.test.ts evaluates each
-- LIVE policy predicate and can_read_case for whole-province, CABA whole-city,
-- locality-scoped, capital-name, revoked and deactivated assignments, and
-- pins the approval type list to GOVT_DECIDABLE_TYPES.
-- Replay-time: the DO block at the end asks the catalog.
--
-- Forward-only, transaction-safe, no data touched.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Policies (verbatim from 0216, locality predicate widened to the
--    whole-province semantics above)
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
                AND (
                  (g.jurisdiction_locality = custody_disputes.jurisdiction_locality)
                  OR (g.jurisdiction_locality = ''::text)
                  OR ((g.jurisdiction_province = 'CABA'::text)
                    AND (g.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
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
          SELECT 1 FROM public.govt_assignments ga
          WHERE (ga.user_id = p.id)
            AND (ga.revoked_at IS NULL)
            AND (ga.jurisdiction_province = pt.jurisdiction_province)
            AND (
              (ga.jurisdiction_locality = pt.jurisdiction_locality)
              OR (ga.jurisdiction_locality = ''::text)
              OR ((ga.jurisdiction_province = 'CABA'::text)
                AND (ga.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
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
          SELECT 1 FROM public.govt_assignments ga
          WHERE (ga.user_id = p.id)
            AND (ga.revoked_at IS NULL)
            AND (ga.jurisdiction_province = pt.jurisdiction_province)
            AND (
              (ga.jurisdiction_locality = pt.jurisdiction_locality)
              OR (ga.jurisdiction_locality = ''::text)
              OR ((ga.jurisdiction_province = 'CABA'::text)
                AND (ga.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
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
              SELECT 1 FROM public.govt_assignments g
              WHERE (g.user_id = p.id)
                AND (g.revoked_at IS NULL)
                AND (g.jurisdiction_province = cd.jurisdiction_province)
                AND (
                  (g.jurisdiction_locality = cd.jurisdiction_locality)
                  OR (g.jurisdiction_locality = ''::text)
                  OR ((g.jurisdiction_province = 'CABA'::text)
                    AND (g.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
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
      -- lib/infra/approval-scope.ts). Without it a whole-province operator
      -- would read every service_dog_credential_verification in the province
      -- through PostgREST — a disability-adjacent inference the application
      -- never shows them. Kept equal to the TS constant by
      -- __tests__/rls/govt-whole-province-rls.test.ts.
      AND (approval_requests.type IN ('role_upgrade_vet'::text, 'organization_verification'::text))
      AND (EXISTS (
        SELECT 1 FROM public.govt_assignments g
        WHERE (g.user_id = (select auth.uid()))
          AND (g.revoked_at IS NULL)
          AND (g.jurisdiction_province = approval_requests.jurisdiction_province)
          AND (
            (g.jurisdiction_locality = approval_requests.jurisdiction_locality)
            OR (g.jurisdiction_locality = ''::text)
            OR ((g.jurisdiction_province = 'CABA'::text)
              AND (g.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires'::text))
          )
      ))
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Function
-- ---------------------------------------------------------------------------

-- Body copied from 0216 (byte-identical to the live catalog before this
-- migration), only the govt branch's locality predicate changed.
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
  -- either — migration 0216. A whole-province assignment (the '' sentinel,
  -- or CABA's INDEC whole-city entry) matches on province alone, mirroring
  -- isWholeProvinceLocality — migration 0241.
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
      and (
        ga.jurisdiction_locality = c.jurisdiction_locality
        or ga.jurisdiction_locality = ''
        or (ga.jurisdiction_province = 'CABA'
          and ga.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires')
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
-- Post-condition fence. ALTER POLICY / CREATE OR REPLACE by name report
-- success and change nothing when the live object was renamed or hand-patched
-- ("aplicada no es cerrada"). Ask the catalog what it actually holds — as
-- EXACT deparsed text, so a stray '' elsewhere in a qual, an ungrouped OR or a
-- dropped province equality cannot pass.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
  -- table | policy | assignment alias | row reference inside that subquery
  expected constant text[] := ARRAY[
    'approval_requests|approval requests visible to applicant or authority|g|approval_requests',
    'custody_dispute_parties|custody_dispute_parties select by parties and authorities|g|cd',
    'custody_disputes|custody_disputes select by parties and authorities|g|custody_disputes',
    'pet_identifications|pet_identifications read by govt in jurisdiction|ga|pt',
    'pet_service_dog|service_dog select by owner or authority|ga|pt'
  ];
  -- The one grouped predicate every assignment subquery must carry. It opens
  -- on `<alias>.revoked_at IS NULL`, and the alias is only in scope inside the
  -- govt_assignments EXISTS, so matching it proves the province equality and
  -- the parenthesised OR sit INSIDE that subquery, ANDed with the active test.
  grouped constant text :=
    '(%1$s.revoked_at IS NULL) AND (%1$s.jurisdiction_province = %2$s.jurisdiction_province)'
    ' AND ((%1$s.jurisdiction_locality = %2$s.jurisdiction_locality)'
    ' OR (%1$s.jurisdiction_locality = ''''::text)'
    ' OR ((%1$s.jurisdiction_province = ''CABA''::text)'
    ' AND (%1$s.jurisdiction_locality = ''Ciudad Autónoma de Buenos Aires''::text)))';
  approval_types constant text :=
    '(type = ANY (ARRAY[''role_upgrade_vet''::text, ''organization_verification''::text]))';
BEGIN
  -- (a) Per policy: it exists; the exact grouped predicate appears exactly
  -- once, after the govt_assignments subquery opens; 0216's lifecycle markers
  -- still precede that subquery (ALTER POLICY replaced the whole expression,
  -- so they are re-asserted rather than assumed).
  SELECT string_agg(split_part(e, '|', 1), '; ')
    INTO offenders
  FROM unnest(expected) AS e
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p,
         LATERAL (SELECT coalesce(p.qual, '') AS text,
                         format(grouped, split_part(e, '|', 3), split_part(e, '|', 4)) AS want) t,
         LATERAL (SELECT substring(t.text FROM position('''govt''::user_role' IN t.text)) AS tail) w,
         LATERAL (SELECT position('govt_assignments' IN w.tail) AS ga,
                         position('deleted_at IS NULL' IN w.tail) AS del,
                         position('deactivated_at IS NULL' IN w.tail) AS dea,
                         position(t.want IN w.tail) AS pred) q
    WHERE p.schemaname = 'public'
      AND p.tablename = split_part(e, '|', 1)
      AND p.policyname = split_part(e, '|', 2)
      AND p.cmd = 'SELECT'
      AND position('''govt''::user_role' IN t.text) > 0
      AND q.ga > 0
      AND q.del > 0 AND q.del < q.ga
      AND q.dea > 0 AND q.dea < q.ga
      AND q.pred > q.ga
      AND (length(t.text) - length(replace(t.text, t.want, ''))) = length(t.want)
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0241 did not close: these policies are missing, or their govt branch lacks the exact grouped whole-province predicate or the 0216 markers in the catalog (%). Inventory pg_policies by real name before retrying.',
      offenders;
  END IF;

  -- (a2) approval_requests: the govt branch carries the GOVT_DECIDABLE_TYPES
  -- filter, between its govt role test and its assignment subquery.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies p,
         LATERAL (SELECT substring(p.qual FROM position('''govt''::user_role' IN p.qual)) AS tail) w
    WHERE p.schemaname = 'public'
      AND p.tablename = 'approval_requests'
      AND p.policyname = 'approval requests visible to applicant or authority'
      AND position(approval_types IN w.tail) > 0
      AND position(approval_types IN w.tail) < position('govt_assignments' IN w.tail)
  ) THEN
    RAISE EXCEPTION 'Migration 0241 did not close: the approval_requests govt branch lacks the GOVT_DECIDABLE_TYPES filter';
  END IF;

  -- (b) Name-independent: in EVERY public policy, each comparison of an
  -- assignment's locality with a row's locality must be one of the exact
  -- grouped predicates above — counted, so a sentinel appearing elsewhere in
  -- the qual cannot vouch for an ungrouped or province-less comparison.
  -- Catches a renamed or newly added name-match policy the list cannot see.
  SELECT string_agg(format('%s "%s"', p.tablename, p.policyname), '; ')
    INTO offenders
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND regexp_count(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
          '\m(g|ga)\.jurisdiction_locality = \w+\.jurisdiction_locality')
     <> regexp_count(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
          '\((g|ga)\.jurisdiction_province = (\w+)\.jurisdiction_province\) AND \(\(\1\.jurisdiction_locality = \2\.jurisdiction_locality\) OR \(\1\.jurisdiction_locality = ''''::text\) OR \(\(\1\.jurisdiction_province = ''CABA''::text\) AND \(\1\.jurisdiction_locality = ''Ciudad Autónoma de Buenos Aires''::text\)\)\)');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0241 did not close: a policy compares govt_assignments locality names outside the grouped whole-province predicate (%).',
      offenders;
  END IF;

  -- (c) The function: the exact govt-branch predicate (whitespace-normalised),
  -- 0216's marker kept, still SECURITY DEFINER with an empty search_path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_read_case'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
      AND p.prosrc LIKE '%and p.role = ''govt''%'
      AND p.prosrc LIKE '%and p.deleted_at is null%'
      AND regexp_replace(p.prosrc, '\s+', ' ', 'g') LIKE
        '%and ga.revoked_at is null'
        ' and ga.jurisdiction_province = c.jurisdiction_province'
        ' and ( ga.jurisdiction_locality = c.jurisdiction_locality'
        ' or ga.jurisdiction_locality = '''''
        ' or (ga.jurisdiction_province = ''CABA'''
        ' and ga.jurisdiction_locality = ''Ciudad Autónoma de Buenos Aires'') )%'
  ) THEN
    RAISE EXCEPTION 'Migration 0241 did not close: public.can_read_case lacks the exact whole-province predicate, the 0216 marker, SECURITY DEFINER or search_path = ''''';
  END IF;
END
$$;

COMMIT;
