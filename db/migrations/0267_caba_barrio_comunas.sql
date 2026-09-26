-- ────────────────────────────────────────────────────────────────────────────
-- 0267_caba_barrio_comunas.sql
-- Every CABA barrio in the catalogue names its comuna (localidades-por-id C5).
--
-- WHY
-- ---------------------------------------------------------------------------
-- The 48 barrios were imported with department_code / department_name NULL
-- (scripts/import-caba-barrios.ts): nothing in the catalogue said which comuna
-- a barrio belongs to, so CABA's comunas could not become authority units. A
-- comuna IS CABA's department for INDEC (codes 02007 … 02105, "Comuna 1" …
-- "Comuna 15"), so the barrio carries it exactly where a Buenos Aires locality
-- carries its partido.
--
-- SOURCE (not typed from memory)
-- ---------------------------------------------------------------------------
-- The rows below are generated from lib/reference/caba-barrio-comunas.json —
-- the official "Barrios por Comuna" resource of data.buenosaires.gob.ar
-- (dataset "barrios", CC-BY-2.5-AR, retrieved 2026-09-26, sha256 in the file),
-- cross-checked against the same dataset's barrio polygons, with the INDEC
-- department codes from the Georef API — reconciled with the catalogue's
-- spelling by lib/reference/caba-comunas.ts. __tests__/caba-barrio-comunas.test.ts
-- holds this file's VALUES equal to that reconciliation, row for row.
--
-- "Belgrano R" is the curated row of migration 0148 (source 'manual'), a part
-- of barrio Belgrano that mirrors its parent: it takes Belgrano's comuna.
--
-- WHAT
-- ---------------------------------------------------------------------------
-- An UPDATE keyed on (province AR-C, locality_slug) over live rows only; the
-- 48 are the importer's own rows (source caba_open_data), Belgrano R is the
-- manual one. A row that already says the right comuna is not touched, so a
-- re-run updates nothing. On an environment whose catalogue has not been
-- imported yet the UPDATE matches nothing: the importer writes the comuna
-- itself from now on.
--
-- The post-condition refuses to commit a catalogue where a live barrio row of
-- either source is missing from this list or says any other comuna.
--
-- Idempotent. Forward-only. Rollback: a forward migration setting the two
-- columns back to NULL on the same rows (nothing reads them as authority until
-- the seed opens comuna units, which are drafts).
-- ────────────────────────────────────────────────────────────────────────────

-- Dropped first so a second run inside one transaction starts clean.
DROP TABLE IF EXISTS pg_temp._caba_barrio_comunas;
CREATE TEMP TABLE _caba_barrio_comunas (
  locality_slug   text PRIMARY KEY,
  department_code text NOT NULL,
  department_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO _caba_barrio_comunas (locality_slug, department_code, department_name) VALUES
    ('agronomia', '02105', 'Comuna 15'),
    ('almagro', '02035', 'Comuna 5'),
    ('balvanera', '02021', 'Comuna 3'),
    ('barracas', '02028', 'Comuna 4'),
    ('belgrano', '02091', 'Comuna 13'),
    ('belgrano-r', '02091', 'Comuna 13'),
    ('boedo', '02035', 'Comuna 5'),
    ('caballito', '02042', 'Comuna 6'),
    ('chacarita', '02105', 'Comuna 15'),
    ('coghlan', '02084', 'Comuna 12'),
    ('colegiales', '02091', 'Comuna 13'),
    ('constitucion', '02007', 'Comuna 1'),
    ('flores', '02049', 'Comuna 7'),
    ('floresta', '02070', 'Comuna 10'),
    ('la-boca', '02028', 'Comuna 4'),
    ('la-paternal', '02105', 'Comuna 15'),
    ('liniers', '02063', 'Comuna 9'),
    ('mataderos', '02063', 'Comuna 9'),
    ('monserrat', '02007', 'Comuna 1'),
    ('monte-castro', '02070', 'Comuna 10'),
    ('nueva-pompeya', '02028', 'Comuna 4'),
    ('nunez', '02091', 'Comuna 13'),
    ('palermo', '02098', 'Comuna 14'),
    ('parque-avellaneda', '02063', 'Comuna 9'),
    ('parque-chacabuco', '02049', 'Comuna 7'),
    ('parque-chas', '02105', 'Comuna 15'),
    ('parque-patricios', '02028', 'Comuna 4'),
    ('puerto-madero', '02007', 'Comuna 1'),
    ('recoleta', '02014', 'Comuna 2'),
    ('retiro', '02007', 'Comuna 1'),
    ('saavedra', '02084', 'Comuna 12'),
    ('san-cristobal', '02021', 'Comuna 3'),
    ('san-nicolas', '02007', 'Comuna 1'),
    ('san-telmo', '02007', 'Comuna 1'),
    ('velez-sarsfield', '02070', 'Comuna 10'),
    ('versalles', '02070', 'Comuna 10'),
    ('villa-crespo', '02105', 'Comuna 15'),
    ('villa-del-parque', '02077', 'Comuna 11'),
    ('villa-devoto', '02077', 'Comuna 11'),
    ('villa-general-mitre', '02077', 'Comuna 11'),
    ('villa-lugano', '02056', 'Comuna 8'),
    ('villa-luro', '02070', 'Comuna 10'),
    ('villa-ortuzar', '02105', 'Comuna 15'),
    ('villa-pueyrredon', '02084', 'Comuna 12'),
    ('villa-real', '02070', 'Comuna 10'),
    ('villa-riachuelo', '02056', 'Comuna 8'),
    ('villa-santa-rita', '02077', 'Comuna 11'),
    ('villa-soldati', '02056', 'Comuna 8'),
    ('villa-urquiza', '02084', 'Comuna 12');

UPDATE public.ar_localities l
   SET department_code = c.department_code,
       department_name = c.department_name
  FROM _caba_barrio_comunas c
 WHERE l.province_code = 'AR-C'
   AND l.removed_at IS NULL
   AND l.source IN ('caba_open_data', 'manual')
   AND l.locality_slug = c.locality_slug
   AND (l.department_code IS DISTINCT FROM c.department_code
        OR l.department_name IS DISTINCT FROM c.department_name);

-- Post-condition -----------------------------------------------------------------

DO $$
DECLARE
  v_unlisted text;
  v_wrong    text;
BEGIN
  -- Every live barrio row the importer or 0148 wrote is in the list.
  SELECT string_agg(l.locality_name, ', ' ORDER BY l.locality_name) INTO v_unlisted
    FROM public.ar_localities l
   WHERE l.province_code = 'AR-C'
     AND l.removed_at IS NULL
     AND l.source IN ('caba_open_data', 'manual')
     AND NOT EXISTS (SELECT 1 FROM _caba_barrio_comunas c WHERE c.locality_slug = l.locality_slug);
  IF v_unlisted IS NOT NULL THEN
    RAISE EXCEPTION '0267: live CABA barrio row(s) with no official comuna: %', v_unlisted;
  END IF;

  -- And each of them says its comuna.
  SELECT string_agg(l.locality_name, ', ' ORDER BY l.locality_name) INTO v_wrong
    FROM public.ar_localities l
    JOIN _caba_barrio_comunas c ON c.locality_slug = l.locality_slug
   WHERE l.province_code = 'AR-C'
     AND l.removed_at IS NULL
     AND l.source IN ('caba_open_data', 'manual')
     AND (l.department_code IS DISTINCT FROM c.department_code
          OR l.department_name IS DISTINCT FROM c.department_name);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '0267: CABA barrio row(s) not carrying their comuna: %', v_wrong;
  END IF;
END;
$$;
