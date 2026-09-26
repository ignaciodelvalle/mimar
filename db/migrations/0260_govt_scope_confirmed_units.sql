-- ────────────────────────────────────────────────────────────────────────────
-- 0260_govt_scope_confirmed_units.sql
-- A DRAFT authority unit governs nothing.
--
-- WHY (localidades-por-id stage D review, W1)
-- -------------------------------------------
-- scripts/seed-authority-units.ts proposes every municipal unit as a DRAFT,
-- derived from INDEC departments; a platform admin confirms each one with the
-- authority. Until then the unit is a proposal, and a proposal must not decide
-- who sees or is paged for anything. The confirm flow
-- (src/modules/organizations/application/authority-units/grant-unit.ts)
-- refuses to move a grant onto a draft unit; this migration is the defense in
-- depth under it: public.govt_scope (0257), which the TS scope and the six RLS
-- predicates (0259) read, only expands a grant through a CONFIRMED unit.
--
--   source 'legacy'    unchanged (authority_unit_id NULL: its name pair).
--   source 'province'  only when the provincial unit is confirmed.
--   source 'locality'  only when the unit is confirmed.
-- A grant pointing at a draft unit therefore covers NOTHING — it is not
-- silently turned back into its name pair either (that would reopen the
-- homonym confusion the unit exists to close).
--
-- NO `SET search_path` CLAUSE, ON PURPOSE. A LANGUAGE sql function with a SET
-- clause is never inlined, and govt_scope runs inside five RLS policies and
-- can_read_case: inlining is what keeps it an initplan-friendly subquery.
-- Every object is schema-qualified instead, and the function is not SECURITY
-- DEFINER (the caller's RLS applies), so a mutable search_path buys an
-- attacker nothing here.
--
-- Idempotent (CREATE OR REPLACE). Forward-only. Rollback: a forward migration
-- restoring 0257's body.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.govt_scope(p_user uuid)
RETURNS TABLE (
  assignment_id uuid,
  source text,
  province_code text,
  locality_id uuid,
  jurisdiction_province text,
  jurisdiction_locality text
)
LANGUAGE sql
STABLE
AS $$
  SELECT g.id, 'legacy'::text, public.ar_province_code(g.jurisdiction_province), NULL::uuid,
         g.jurisdiction_province, g.jurisdiction_locality
    FROM public.govt_assignments g
   WHERE g.user_id = p_user
     AND g.revoked_at IS NULL
     AND g.authority_unit_id IS NULL
  UNION ALL
  SELECT g.id, 'province'::text, u.province_code, NULL::uuid, NULL::text, NULL::text
    FROM public.govt_assignments g
    JOIN public.authority_units u ON u.id = g.authority_unit_id
   WHERE g.user_id = p_user
     AND g.revoked_at IS NULL
     AND u.kind = 'provincia'
     AND u.status = 'confirmed'
  UNION ALL
  SELECT g.id, 'locality'::text, u.province_code, m.locality_id, NULL::text, NULL::text
    FROM public.govt_assignments g
    JOIN public.authority_units u ON u.id = g.authority_unit_id
    JOIN public.authority_unit_localities m ON m.unit_id = u.id AND m.valid_to IS NULL
   WHERE g.user_id = p_user
     AND g.revoked_at IS NULL
     AND u.kind <> 'provincia'
     AND u.status = 'confirmed'
$$;

COMMENT ON FUNCTION public.govt_scope(uuid) IS
  'What a govt user''s ACTIVE grants cover (0257; confirmed units only since 0260). source=legacy: the grant''s name pair (authority_unit_id NULL, read with the old name semantics, identical on both paths); source=province: a CONFIRMED provincial unit, the whole province incl. unresolved rows; source=locality: one row per active member locality of a CONFIRMED unit. A grant on a draft unit covers nothing. No SET search_path on purpose: it would stop inlining inside RLS; every name is schema-qualified.';

-- Post-condition: the live body filters both unit branches on confirmed, is
-- still STABLE, not SECURITY DEFINER, and carries no SET clause.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'govt_scope'
       AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig IS NULL
       AND (length(p.prosrc) - length(replace(p.prosrc, 'u.status = ''confirmed''', '')))
           = 2 * length('u.status = ''confirmed''')
  ) THEN
    RAISE EXCEPTION 'Migration 0260 did not close: public.govt_scope must filter both unit branches on status = ''confirmed'', stay STABLE, not SECURITY DEFINER, with no SET clause';
  END IF;
END
$$;

COMMIT;
