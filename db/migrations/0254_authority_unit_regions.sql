-- ────────────────────────────────────────────────────────────────────────────
-- 0254_authority_unit_regions.sql
-- A `region` authority unit, at its own level between provincia and municipio;
-- and the one definition of which units govern a place.
--
-- WHY (localidades-por-id, stage C addendum, PO-informed)
-- -------------------------------------------------------
-- Some oversight is neither a province nor a municipality: the Province of
-- Buenos Aires runs 12 regiones sanitarias, and a province may split its
-- oversight across three or four accounts, each over several partidos. A
-- region groups localities BELOW its province and ABOVE the municipio.
--
--   - `kind = 'region'` sits at its OWN level, `regional`, and only a region
--     does (authority_units_kind_level). The one-active-membership rule stays
--     per (locality, level), so a locality holds one municipal AND one
--     regional membership at once, and is never in two regions at a time.
--   - Regions are created by a platform admin. They have no INDEC source, so
--     scripts/seed-authority-units.ts never invents one.
--   - A region, like a municipio, governs only its explicit members. A place
--     that never resolved to a locality (locality_id NULL) reaches ONLY the
--     provincial unit of its province — never a region, which would widen an
--     unresolved row to part of a province on no evidence (P1/P3).
--
-- That last rule gets one home: `public.authority_units_for_place(locality,
-- province)` returns the units governing a place — the provincial unit of the
-- locality's province (or of the given province when the place is
-- unresolved) plus every unit with an ACTIVE membership of the locality. The
-- locality's own province wins over the one passed in: the catalogue row
-- decides, never a name. LANGUAGE sql STABLE, not SECURITY DEFINER, so the
-- caller's RLS applies and the planner may inline it. Nothing reads it before
-- stage D (scope, routing and rules build on it).
--
-- Cascade order after this migration:
--   provincial > regional > municipal > submunicipal
--
-- Idempotent (DROP ... IF EXISTS / CREATE OR REPLACE). Forward-only.
-- Rollback: no region exists until an admin creates one; a forward migration
-- may narrow the CHECKs back once none does.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.authority_units DROP CONSTRAINT IF EXISTS authority_units_kind_check;
ALTER TABLE public.authority_units ADD CONSTRAINT authority_units_kind_check
  CHECK (kind IN ('provincia', 'region', 'municipio', 'ciudad', 'comuna', 'departamento'));

ALTER TABLE public.authority_units DROP CONSTRAINT IF EXISTS authority_units_level_check;
ALTER TABLE public.authority_units ADD CONSTRAINT authority_units_level_check
  CHECK (level IN ('provincial', 'regional', 'municipal', 'submunicipal'));

ALTER TABLE public.authority_units DROP CONSTRAINT IF EXISTS authority_units_kind_level;
ALTER TABLE public.authority_units ADD CONSTRAINT authority_units_kind_level
  CHECK ((kind = 'provincia') = (level = 'provincial')
     AND (kind = 'region') = (level = 'regional'));

ALTER TABLE public.authority_unit_localities DROP CONSTRAINT IF EXISTS authority_unit_localities_level_check;
ALTER TABLE public.authority_unit_localities ADD CONSTRAINT authority_unit_localities_level_check
  CHECK (level IN ('regional', 'municipal', 'submunicipal'));

COMMENT ON TABLE public.authority_units IS
  'Who governs: a provincia, region, municipio, ciudad, comuna or departamento (localidades-por-id C1, region 0254). Levels: provincial > regional > municipal > submunicipal. Seeded as draft from INDEC departments (scripts/seed-authority-units.ts; regions never seeded); a platform admin confirms each one. Never deleted.';

CREATE OR REPLACE FUNCTION public.authority_units_for_place(
  p_locality_id uuid,
  p_province_code text
)
RETURNS TABLE (unit_id uuid, level text)
LANGUAGE sql
STABLE
AS $$
  SELECT u.id, u.level
    FROM public.authority_units u
   WHERE u.kind = 'provincia'
     AND u.province_code = COALESCE(
           (SELECT l.province_code FROM public.ar_localities l WHERE l.id = p_locality_id),
           p_province_code)
  UNION ALL
  SELECT u.id, u.level
    FROM public.authority_unit_localities m
    JOIN public.authority_units u ON u.id = m.unit_id
   WHERE p_locality_id IS NOT NULL
     AND m.locality_id = p_locality_id
     AND m.valid_to IS NULL
$$;

REVOKE ALL ON FUNCTION public.authority_units_for_place(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authority_units_for_place(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.authority_units_for_place(uuid, text) IS
  'The units governing a place (0254): the provincial unit of its province, plus every unit with an active membership of the locality. An unresolved place (NULL locality) reaches ONLY the provincial unit, never a region.';
