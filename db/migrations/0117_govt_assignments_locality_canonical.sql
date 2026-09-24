-- Canonicalize govt_assignments.jurisdiction_locality against the ar_localities
-- catalog (issue #758 / task #9).
--
-- Background: lib/metrics/scope.ts (jurisdictionPairClause) matches a govt
-- user's scope by EXACT string equality against pets.jurisdiction_province /
-- pets.jurisdiction_locality. A govt_assignments row whose locality text does
-- not resolve against ar_localities silently produces an EMPTY scope for that
-- assignment — no error, just zero rows. The two real app write paths
-- (assignGovtLocalityForAuthority, createInstitutionalAccountForAuthority)
-- already canonicalize at write time via resolveCanonicalJurisdiction. This
-- migration is a one-time backfill/repair for rows that predate that
-- guarantee (inserted directly by scripts/seed-test-users.ts and
-- scripts/seed-demo-scenario.ts, which bypassed the writer).
--
-- This migration, for every row in govt_assignments:
--   1. Resolves jurisdiction_locality against ar_localities, scoped by the
--      province_code derived from the row's (already-canonical, CHECK-
--      enforced by migration 0055) jurisdiction_province value. Resolution
--      mirrors localityByName() in lib/infra/ar-localidades.ts: try
--      locality_slug = normalize(input) first (unaccent, lowercase, strip
--      periods, collapse whitespace, spaces→hyphens), then fall back to a
--      case-insensitive locality_name match. Both scoped to province_code
--      and removed_at IS NULL.
--   2. Where it resolves but the stored text differs from the catalog's
--      canonical locality_name (case/accents) → UPDATE to the canonical
--      spelling.
--   3. Where it does NOT resolve and the row is still ACTIVE
--      (revoked_at IS NULL) → auto-revoke it (revoked_at = now(),
--      revoked_by_user_id = NULL, revocation_reason explaining why). We do
--      NOT guess what the intended locality was — inventing data would be
--      worse than an honest gap. Functionally this changes no user-visible
--      behavior: an unresolvable locality already matched nothing in
--      jurisdictionPairClause, so the assignment was already contributing
--      zero real scope. Revoking it just makes the row's state honest.
--   4. Rows that are already revoked and don't resolve are left untouched —
--      they're already inactive, nothing to fix.
--
-- No CHECK constraint or trigger is added for jurisdiction_locality: the
-- locality catalog is ~4500 rows (not a fixed 24-value enum like province),
-- a CHECK can't reference another table, and a trigger is more machinery
-- than this fix needs. Enforcement lives at write time (already done for
-- both real writers) plus the integrity fitness test added alongside this
-- migration (__tests__/govt-assignments-locality-integrity.test.ts).
--
-- ROLLBACK NOTES: reverting this migration (i.e. not running it, or manually
-- undoing it) does NOT restore whatever revoked_at state existed before —
-- the original garbage jurisdiction_locality text is preserved in the row
-- (never overwritten for unresolvable rows), only revoked_at /
-- revoked_by_user_id / revocation_reason are changed for those rows. To
-- manually un-revoke a row this migration touched:
--
--   UPDATE govt_assignments
--   SET revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL
--   WHERE revocation_reason LIKE 'Auto-revoked by migration 0117%';
--
-- Do this ONLY after fixing jurisdiction_locality to a value that actually
-- resolves against ar_localities — otherwise you reintroduce the silent
-- empty-scope bug this migration exists to close.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Helper: province name → province_code. Inverted from the canonical-name
-- CASE mapping in db/migrations/0055_jurisdiction_province_canonical.sql —
-- do not invent a different mapping.
-- ────────────────────────────────────────────────────────────────────────────

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

-- ────────────────────────────────────────────────────────────────────────────
-- Helper: resolve (province_name, locality_input) → canonical locality_name,
-- or NULL if unresolvable. Mirrors localityByName() in
-- lib/infra/ar-localidades.ts: slug match first, then case-insensitive
-- locality_name match, both scoped to province_code and removed_at IS NULL.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.canonicalize_locality(province_name text, locality_input text)
RETURNS text AS $$
DECLARE
  p_code text;
  normalized text;
  slug_candidate text;
  result text;
BEGIN
  IF locality_input IS NULL OR length(trim(locality_input)) = 0 THEN
    RETURN NULL;
  END IF;

  p_code := pg_temp.province_code_for_name(province_name);
  IF p_code IS NULL THEN
    RETURN NULL;
  END IF;

  -- normalize(): NFD-strip accents, lowercase, drop periods, collapse
  -- whitespace, trim — matches lib/infra/ar-localidades.ts normalize().
  normalized := lower(unaccent(locality_input));
  normalized := replace(normalized, '.', '');
  normalized := regexp_replace(normalized, '\s+', ' ', 'g');
  normalized := trim(normalized);
  slug_candidate := replace(normalized, ' ', '-');

  SELECT locality_name INTO result
  FROM ar_localities
  WHERE province_code = p_code
    AND locality_slug = slug_candidate
    AND removed_at IS NULL
  ORDER BY department_name
  LIMIT 1;
  IF result IS NOT NULL THEN RETURN result; END IF;

  SELECT locality_name INTO result
  FROM ar_localities
  WHERE province_code = p_code
    AND lower(locality_name) = lower(locality_input)
    AND removed_at IS NULL
  ORDER BY department_name
  LIMIT 1;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Spelling backfill: rows that resolve but are stored with a different
--    casing/accent than the catalog's canonical locality_name.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE govt_assignments
SET jurisdiction_locality = pg_temp.canonicalize_locality(jurisdiction_province, jurisdiction_locality)
WHERE pg_temp.canonicalize_locality(jurisdiction_province, jurisdiction_locality) IS NOT NULL
  AND pg_temp.canonicalize_locality(jurisdiction_province, jurisdiction_locality) <> jurisdiction_locality;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Auto-revoke ACTIVE rows that do not resolve against ar_localities.
--    Already-revoked unresolvable rows are left untouched (no action needed).
-- ────────────────────────────────────────────────────────────────────────────

UPDATE govt_assignments
SET revoked_at = now(),
    revoked_by_user_id = NULL,
    revocation_reason = 'Auto-revoked by migration 0117: jurisdiction_locality does not resolve against ar_localities (issue #758).'
WHERE revoked_at IS NULL
  AND pg_temp.canonicalize_locality(jurisdiction_province, jurisdiction_locality) IS NULL;

COMMIT;
