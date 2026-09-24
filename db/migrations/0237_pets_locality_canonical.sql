-- Migration 0237 — canonicalize pets.jurisdiction_locality against the
-- ar_localities catalog (finding A10-4, 2026-09 fresh review). The pets
-- sibling of 0117, which did the same for govt_assignments only.
--
-- WHY: every locality-scoped read (lib/metrics/scope.ts jurisdictionPairClause,
-- the census, the compliance rollups, resolveBusinessRule) matches a pet by
-- EXACT string equality on (jurisdiction_province, jurisdiction_locality). A
-- pet whose locality text is a non-catalog spelling ("palermo", "Rio Cuarto",
-- a trailing space) silently falls out of the municipality that governs it.
-- Every application write path already canonicalizes through
-- normalizeLocationForWrite; this is the one-time repair for rows that predate
-- that guarantee or came in by another road (scripts, manual SQL).
--
-- WHAT IT DOES, for every pets row whose (province, locality) does NOT already
-- match a live catalog row exactly:
--   1. Collects the catalog candidates the way localityByName() in
--      lib/infra/ar-localidades.ts does — slug of the normalized input, or a
--      case-insensitive locality_name match — scoped to the province_code of
--      the row's (CHECK-enforced canonical, 0055) jurisdiction_province and to
--      removed_at IS NULL.
--   2. If ALL candidates carry ONE distinct locality_name, rewrites the text to
--      that name. This is a spelling fix: it cannot move a pet, because the
--      province is fixed and the name was already the name.
--   3. If there are zero candidates, or candidates with two different names,
--      the row is LEFT ALONE. localityByName would pick the alphabetically
--      first department's row; a migration must not guess (0117's rule).
--      Those rows are what __tests__/pets-locality-integrity.test.ts reports,
--      and each one it tolerates is allowlisted there with a reason.
--
-- WHAT IT DOES NOT DO:
--   - It never touches jurisdiction_province (0055 already made it canonical)
--     nor locality_id (the 0147 FK twin has its own writers; filling it from a
--     display name would make the name a join key, which it is not).
--   - It writes no pet_events row. pets.jurisdiction_* is a dual-written cache
--     (invariant 3); rederivePetCache canonicalizes the event payload with the
--     same localityByName, so the repaired value is what re-derivation yields
--     for a single-name match — the repair removes drift, it does not add it.
--   - No CHECK or trigger: a CHECK cannot reference ar_localities, and write
--     paths plus the fitness test are the enforcement (same as 0117).
--
-- DETERMINISTIC AND IDEMPOTENT: the result depends only on the row and the
-- catalog; a second run finds every repaired row already exact and matches
-- nothing. The NOTICE lines report how many rows were repaired and how many
-- non-matching rows remain, so the apply log is the before/after inventory.
--
-- ROLLBACK: the original text is not kept. The repair only ever replaces a
-- spelling with the catalog's own spelling of the same (province, locality),
-- so there is nothing meaningful to restore.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Province display name → province_code. Same mapping as 0117 (inverted from
-- 0055's canonical-name CASE). Do not invent a different one.
CREATE OR REPLACE FUNCTION pg_temp.province_code_for_name(province_name text) RETURNS text AS $$
BEGIN
  RETURN CASE province_name
    WHEN 'Buenos Aires'          THEN 'AR-B'
    WHEN 'CABA'                  THEN 'AR-C'
    WHEN 'Catamarca'             THEN 'AR-K'
    WHEN 'Chaco'                 THEN 'AR-H'
    WHEN 'Chubut'                THEN 'AR-U'
    WHEN 'Córdoba'               THEN 'AR-X'
    WHEN 'Corrientes'            THEN 'AR-W'
    WHEN 'Entre Ríos'            THEN 'AR-E'
    WHEN 'Formosa'               THEN 'AR-P'
    WHEN 'Jujuy'                 THEN 'AR-Y'
    WHEN 'La Pampa'              THEN 'AR-L'
    WHEN 'La Rioja'              THEN 'AR-F'
    WHEN 'Mendoza'               THEN 'AR-M'
    WHEN 'Misiones'              THEN 'AR-N'
    WHEN 'Neuquén'               THEN 'AR-Q'
    WHEN 'Río Negro'             THEN 'AR-R'
    WHEN 'Salta'                 THEN 'AR-A'
    WHEN 'San Juan'              THEN 'AR-J'
    WHEN 'San Luis'              THEN 'AR-D'
    WHEN 'Santa Cruz'            THEN 'AR-Z'
    WHEN 'Santa Fe'              THEN 'AR-S'
    WHEN 'Santiago del Estero'   THEN 'AR-G'
    WHEN 'Tierra del Fuego'      THEN 'AR-V'
    WHEN 'Tucumán'               THEN 'AR-T'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- True when (province, locality) already names a live catalog row exactly.
CREATE OR REPLACE FUNCTION pg_temp.locality_is_exact(province_name text, locality_input text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM ar_localities
    WHERE province_code = pg_temp.province_code_for_name(province_name)
      AND locality_name = locality_input
      AND removed_at IS NULL
  );
$$ LANGUAGE sql STABLE;

-- The catalog's spelling of locality_input within the province, or NULL when
-- there is no candidate or the candidates disagree on the name. normalize()
-- mirrors lib/infra/ar-localidades.ts: strip accents, lowercase, drop
-- periods, collapse whitespace, trim; the slug turns spaces into hyphens.
CREATE OR REPLACE FUNCTION pg_temp.unambiguous_locality_name(province_name text, locality_input text)
RETURNS text AS $$
DECLARE
  p_code text;
  slug_candidate text;
  names text[];
BEGIN
  IF locality_input IS NULL OR length(trim(locality_input)) = 0 THEN
    RETURN NULL;
  END IF;
  p_code := pg_temp.province_code_for_name(province_name);
  IF p_code IS NULL THEN
    RETURN NULL;
  END IF;

  slug_candidate := replace(
    trim(regexp_replace(replace(lower(unaccent(locality_input)), '.', ''), '\s+', ' ', 'g')),
    ' ', '-');

  SELECT array_agg(DISTINCT locality_name) INTO names
  FROM ar_localities
  WHERE province_code = p_code
    AND removed_at IS NULL
    AND (locality_slug = slug_candidate OR lower(locality_name) = lower(trim(locality_input)));

  IF names IS NULL OR cardinality(names) <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN names[1];
END;
$$ LANGUAGE plpgsql STABLE;

DO $$
DECLARE
  before_count integer;
  repaired integer;
  after_count integer;
BEGIN
  SELECT count(*) INTO before_count FROM pets
  WHERE jurisdiction_province IS NOT NULL
    AND jurisdiction_locality IS NOT NULL
    AND NOT pg_temp.locality_is_exact(jurisdiction_province, jurisdiction_locality);

  UPDATE pets
  SET jurisdiction_locality = pg_temp.unambiguous_locality_name(jurisdiction_province, jurisdiction_locality)
  WHERE jurisdiction_province IS NOT NULL
    AND jurisdiction_locality IS NOT NULL
    AND NOT pg_temp.locality_is_exact(jurisdiction_province, jurisdiction_locality)
    AND pg_temp.unambiguous_locality_name(jurisdiction_province, jurisdiction_locality) IS NOT NULL;
  GET DIAGNOSTICS repaired = ROW_COUNT;

  SELECT count(*) INTO after_count FROM pets
  WHERE jurisdiction_province IS NOT NULL
    AND jurisdiction_locality IS NOT NULL
    AND NOT pg_temp.locality_is_exact(jurisdiction_province, jurisdiction_locality);

  RAISE NOTICE '0237 pets locality: % non-matching before, % repaired, % left alone (unresolvable or ambiguous)',
    before_count, repaired, after_count;
END;
$$;
