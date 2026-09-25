-- ────────────────────────────────────────────────────────────────────────────
-- 0246_govt_assignments_locality_id.sql
-- govt_assignments records WHICH catalogue row was granted, not just its name.
--
-- WHY (C2b)
-- ---------
-- A govt grant was stored as a (province, locality NAME) pair, and both admin
-- write paths re-resolved that name through `localityByName`, which takes the
-- alphabetically first department when a province has two localities with the
-- same name. The INDEC catalogue ships 68 such (province, name) collisions
-- (Mechita: Alberti and Bragado; Torres: Exaltación de la Cruz and Luján; ...).
-- The picker on /admin/govts SHOWED the admin both rows with their departments
-- and resolved the INDEC id of the one they tapped — and the form threw that id
-- away, so the grant record could name a locality the admin never chose.
--
-- The citizen paths closed the same hole with `localityIndecId`
-- (A2-alta-asentar-03) and the `locality_id` FK on pets / welfare_reports /
-- cases (migration 0147). This gives the grant record the same FK: the
-- ar_localities uuid PK, so CABA barrios (null indec_id) are attributable too.
--
-- ADDITIVE / NULLABLE
-- -------------------
-- jurisdiction_province / jurisdiction_locality STAY the display source and the
-- scope key every reader uses today (jurisdictionPairClause, the RLS policies).
-- Nothing reads locality_id yet; this migration only stops the grant from
-- forgetting which row it was. NULL means one of:
--   - a whole-province grant (locality = '' sentinel): there is no row;
--   - a legacy row whose name is ambiguous inside its province — left NULL on
--     purpose, because guessing a department is exactly the defect being fixed.
--
-- The unique index on (user_id, province, locality) is unchanged: while scope
-- is matched by name, two homonyms granted to one operator would be the same
-- scope twice. The writers refuse that case with a message instead of the
-- silent no-op the name-only duplicate check used to answer.
--
-- Idempotent-safe (IF NOT EXISTS, backfill only touches NULL rows).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE govt_assignments
  ADD COLUMN IF NOT EXISTS locality_id uuid
  REFERENCES ar_localities (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS govt_assignments_locality_id_idx
  ON govt_assignments (locality_id)
  WHERE locality_id IS NOT NULL;

-- Backfill: only rows whose stored (province, canonical name) pair names
-- EXACTLY ONE live catalogue row. Stored names are already canonical
-- (migration 0117 + both writers), so equality on locality_name is the match.
-- Province name -> code is 0117's mapping, inverted from 0055 — do not invent
-- a different one.
WITH province_codes(province_name, province_code) AS (
  VALUES
    ('Buenos Aires', 'AR-B'), ('CABA', 'AR-C'), ('Catamarca', 'AR-K'),
    ('Chaco', 'AR-H'), ('Chubut', 'AR-U'), ('Córdoba', 'AR-X'),
    ('Corrientes', 'AR-W'), ('Entre Ríos', 'AR-E'), ('Formosa', 'AR-P'),
    ('Jujuy', 'AR-Y'), ('La Pampa', 'AR-L'), ('La Rioja', 'AR-F'),
    ('Mendoza', 'AR-M'), ('Misiones', 'AR-N'), ('Neuquén', 'AR-Q'),
    ('Río Negro', 'AR-R'), ('Salta', 'AR-A'), ('San Juan', 'AR-J'),
    ('San Luis', 'AR-D'), ('Santa Cruz', 'AR-Z'), ('Santa Fe', 'AR-S'),
    ('Santiago del Estero', 'AR-G'), ('Tierra del Fuego', 'AR-V'),
    ('Tucumán', 'AR-T')
),
unambiguous AS (
  SELECT pc.province_name, l.locality_name, min(l.id::text)::uuid AS locality_id
  FROM ar_localities l
  JOIN province_codes pc ON pc.province_code = l.province_code
  WHERE l.removed_at IS NULL
  GROUP BY pc.province_name, l.locality_name
  HAVING count(*) = 1
)
UPDATE govt_assignments ga
SET locality_id = u.locality_id
FROM unambiguous u
WHERE ga.locality_id IS NULL
  AND ga.jurisdiction_province = u.province_name
  AND ga.jurisdiction_locality = u.locality_name;
