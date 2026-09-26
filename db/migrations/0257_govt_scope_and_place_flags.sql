-- ────────────────────────────────────────────────────────────────────────────
-- 0257_govt_scope_and_place_flags.sql
-- What a govt user covers, answered once; the per-consumer switch from the
-- name path to the id path; and the sink where the two paths disagree.
--
-- WHY (localidades-por-id D1)
-- ---------------------------
-- Scope (lib/metrics/scope.ts), routing (approval-routing.ts), rules
-- (business-rules-resolver.ts) and six RLS surfaces each re-derived "which
-- rows does this operator govern?" from govt_assignments' (province,
-- locality) TEXT. Stage D gives that question one answer in SQL, and moves
-- each consumer to it behind a flag, one at a time, after a parity check.
--
-- 1. public.govt_scope(user) — one row per thing the user's ACTIVE grants
--    cover. `source` says which path the row belongs to:
--
--      legacy    a grant with authority_unit_id NULL: its name pair, exactly
--                as stored (jurisdiction_province, jurisdiction_locality). A
--                consumer applies the name semantics it always applied, so a
--                legacy grant answers IDENTICALLY on both paths — nothing is
--                widened by switching a consumer. The two columns keep the
--                grant's own names ON PURPOSE: a policy comparing them with a
--                row's jurisdiction_locality is still a name join, and the
--                name-join fences (lint:locality-name-join, the live
--                inventory) must keep seeing it until stage E retires it.
--      province  a grant on a provincial unit: the whole province
--                (province_code), including rows whose place never resolved.
--      locality  a grant on any other unit: one row per ACTIVE member
--                locality (locality_id). A row whose place is unresolved has
--                no locality_id, so it never matches here (P1/P3: an
--                unresolved place reaches only its province).
--
--    Each grant is on ONE path: authority_unit_id NULL or set, never both
--    and never OR'd (design). LANGUAGE sql STABLE, not SECURITY DEFINER: the
--    caller's RLS applies ("govt sees own assignments", 0215) and the planner
--    can inline it into a policy.
--
-- 2. public.place_read_flags(consumer, mode) — name | shadow | id, one row
--    per consumer, all seeded 'name'. Flipping is an operator act after the
--    parity sweep (scripts/place-parity-sweep.ts); rolling back is setting
--    the row back to 'name', no deploy. The consumer list is closed by CHECK
--    and fenced against lib/place/flags.ts
--    (__tests__/place-read-flags-known-consumers.test.ts).
--
-- 3. public.place_shadow_disagreements — where a consumer in 'shadow' mode
--    writes each disagreement between the two paths, classified
--    (lib/place/shadow.ts), deduplicated per (consumer, subject, kind).
--    Retention 30 days (the sink prunes on write).
--
-- RLS: platform admins read both tables (aal2); writes are server-only.
-- Neither holds data about a person: a flag is configuration, and a
-- disagreement names rows and official recipients by id.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING).
-- Forward-only. Rollback: every flag back to 'name'; nothing else reads these.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. govt_scope ----------------------------------------------------------------

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
  UNION ALL
  SELECT g.id, 'locality'::text, u.province_code, m.locality_id, NULL::text, NULL::text
    FROM public.govt_assignments g
    JOIN public.authority_units u ON u.id = g.authority_unit_id
    JOIN public.authority_unit_localities m ON m.unit_id = u.id AND m.valid_to IS NULL
   WHERE g.user_id = p_user
     AND g.revoked_at IS NULL
     AND u.kind <> 'provincia'
$$;

REVOKE ALL ON FUNCTION public.govt_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.govt_scope(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.govt_scope(uuid) IS
  'What a govt user''s ACTIVE grants cover (0257, localidades-por-id D1). source=legacy: the grant''s name pair (authority_unit_id NULL, read with the old name semantics, identical on both paths); source=province: a provincial unit, the whole province incl. unresolved rows; source=locality: one row per active member locality of the unit. Never both paths for one grant.';

-- 2. place_read_flags ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.place_read_flags (
  consumer text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'name',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_read_flags_consumer_check
    CHECK (consumer IN ('scope', 'routing', 'rules', 'coverage', 'public_filters', 'panorama')),
  CONSTRAINT place_read_flags_mode_check
    CHECK (mode IN ('name', 'shadow', 'id'))
);

INSERT INTO public.place_read_flags (consumer, mode) VALUES
  ('scope', 'name'),
  ('routing', 'name'),
  ('rules', 'name'),
  ('coverage', 'name'),
  ('public_filters', 'name'),
  ('panorama', 'name')
ON CONFLICT (consumer) DO NOTHING;

COMMENT ON TABLE public.place_read_flags IS
  'Per-consumer switch from the name path to the id path (localidades-por-id D1): name | shadow (serve name, record disagreements) | id. Flipped by an operator after the parity sweep; rollback = back to name, no deploy.';

-- 3. place_shadow_disagreements ------------------------------------------------

CREATE TABLE IF NOT EXISTS public.place_shadow_disagreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer text NOT NULL,
  kind text NOT NULL,
  subject_table text NOT NULL,
  subject_key text NOT NULL,
  name_result jsonb NOT NULL,
  id_result jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1,
  CONSTRAINT place_shadow_disagreements_consumer_check
    CHECK (consumer IN ('scope', 'routing', 'rules', 'coverage', 'public_filters', 'panorama')),
  CONSTRAINT place_shadow_disagreements_kind_check
    CHECK (kind IN ('homonym_split', 'spelling_join', 'unresolved_to_province', 'unit_widening', 'legacy_grant', 'other')),
  CONSTRAINT place_shadow_disagreements_subject_check
    CHECK (length(subject_table) BETWEEN 1 AND 64 AND length(subject_key) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS place_shadow_disagreements_dedup
  ON public.place_shadow_disagreements (consumer, subject_table, subject_key, kind);
CREATE INDEX IF NOT EXISTS place_shadow_disagreements_last_seen_idx
  ON public.place_shadow_disagreements (last_seen_at);

COMMENT ON TABLE public.place_shadow_disagreements IS
  'Where a consumer in shadow mode records each disagreement between the name path and the id path, classified by lib/place/shadow.ts (localidades-por-id D1). One row per (consumer, subject, kind), counted. 30-day retention.';

-- 4. RLS -----------------------------------------------------------------------

ALTER TABLE public.place_read_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.place_shadow_disagreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "place_read_flags select by admin" ON public.place_read_flags;
CREATE POLICY "place_read_flags select by admin"
  ON public.place_read_flags
  FOR SELECT
  TO authenticated
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

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.place_read_flags;
CREATE POLICY "institutional sessions require aal2" ON public.place_read_flags
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

DROP POLICY IF EXISTS "place_shadow_disagreements select by admin" ON public.place_shadow_disagreements;
CREATE POLICY "place_shadow_disagreements select by admin"
  ON public.place_shadow_disagreements
  FOR SELECT
  TO authenticated
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

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.place_shadow_disagreements;
CREATE POLICY "institutional sessions require aal2" ON public.place_shadow_disagreements
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

-- 5. Post-condition --------------------------------------------------------------
-- "Aplicada no es cerrada": ask the catalog what it holds.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.place_read_flags) <> 6 THEN
    RAISE EXCEPTION 'Migration 0257 did not close: place_read_flags must hold exactly the 6 consumers';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'govt_scope'
       AND NOT p.prosecdef AND p.provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'Migration 0257 did not close: public.govt_scope must exist, STABLE and not SECURITY DEFINER';
  END IF;
END
$$;

COMMIT;
