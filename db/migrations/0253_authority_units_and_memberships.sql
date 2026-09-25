-- ────────────────────────────────────────────────────────────────────────────
-- 0253_authority_units_and_memberships.sql
-- Who governs which localities: an authority UNIT and its dated membership.
--
-- WHY (localidades-por-id C1)
-- ---------------------------
-- P3: always reach exactly the right authority. Until now a municipality was
-- N `govt_assignments` rows, one per locality NAME, typed by hand. A partido
-- onboarded with 8 of its 9 localities silently routed the ninth's bites to
-- national admins (R2 of the 2026-09-25 audit), and a homonym in another
-- partido or province matched by name.
--
-- An authority unit is DATA, not a derivation (PO decision D1):
--
--   authority_units            one row per provincia, municipio, ciudad,
--                              comuna or departamento. `level` says where it
--                              sits in the cascade (provincial > municipal >
--                              submunicipal); `kind` says what it is. A
--                              Santa Fe "comuna" is municipal, a CABA comuna
--                              is submunicipal: that is why both columns exist.
--                              `departamento` is the seed's honest name for an
--                              INDEC department proposed as a unit outside
--                              Buenos Aires, where a department is not a
--                              municipality; `status` stays 'draft' until a
--                              platform admin confirms it with the authority.
--   authority_unit_localities  which catalogue localities a unit governs, by
--                              ar_localities.id, from valid_from to valid_to.
--                              A membership is opened and CLOSED, never
--                              rewritten and never deleted: the rows say
--                              who added and who ended it, and when. The
--                              WHY is free text about a person's decision,
--                              so it lives in audit_log (which the subject
--                              rights RPCs reach), written by the C4 editor
--                              in the same transaction. One ACTIVE
--                              membership per (locality, level).
--
-- A provincial unit has no explicit members: it covers every row of its
-- province, including the ones whose place never resolved to a locality.
--
-- Current membership decides visibility (design addendum #2): the authority
-- that governs a locality today sees its history. The event's own place is
-- never touched by a membership change (P2).
--
-- Both tables are created EMPTY and unread: scripts/seed-authority-units.ts
-- (C2) fills them from the catalogue, because ar_localities is imported after
-- migrations and its content is environment-specific. Nothing reads them
-- until stage D.
--
-- RLS: institutional accounts (platform admin, govt operator) read through
-- PostgREST, aal2-restricted as every institutional surface (0231). Writes
-- are server-only (service role): the seed and the /admin editor (C4).
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
-- Forward-only. Rollback: both tables are unread until stage D — a forward
-- migration may drop them.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. authority_units ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.authority_units (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text        NOT NULL CHECK (kind IN (
                                      'provincia', 'municipio', 'ciudad', 'comuna', 'departamento')),
  level                 text        NOT NULL CHECK (level IN (
                                      'provincial', 'municipal', 'submunicipal')),
  province_code         text        NOT NULL CHECK (province_code ~ '^AR-[A-Z]$'),
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- The INDEC department the seed derived the unit from (NULL for CABA, a
  -- provincia, or a unit an admin created by hand).
  indec_department_code text,
  parent_unit_id        uuid        REFERENCES public.authority_units (id) ON DELETE RESTRICT,
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  -- The platform admin who confirmed the unit with the authority. No FK on
  -- purpose, same as place_resolutions.actor_user_id.
  confirmed_by          uuid,
  confirmed_at          timestamptz,
  -- The seed's natural key ('provincia:AR-B', 'departamento:AR-X:14042',
  -- 'ciudad:AR-C'): what makes a re-run idempotent. NULL for hand-made units.
  seed_key              text        UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authority_units_kind_level CHECK ((kind = 'provincia') = (level = 'provincial')),
  CONSTRAINT authority_units_provincia_is_root CHECK (kind <> 'provincia' OR parent_unit_id IS NULL),
  CONSTRAINT authority_units_confirmed_has_date CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);

-- One provincial unit per province.
CREATE UNIQUE INDEX IF NOT EXISTS authority_units_one_provincia
  ON public.authority_units (province_code) WHERE kind = 'provincia';
CREATE INDEX IF NOT EXISTS authority_units_province_idx
  ON public.authority_units (province_code);

-- level and province are what membership rows and the cascade are built on:
-- they never move once a unit exists. A unit is never deleted.
CREATE OR REPLACE FUNCTION public.enforce_authority_unit_shape()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_province text;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'authority_units: a unit is never deleted (% refused). Leave it without members instead.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.level IS DISTINCT FROM OLD.level
                           OR NEW.province_code IS DISTINCT FROM OLD.province_code) THEN
    RAISE EXCEPTION 'authority_units: level and province_code never change (unit %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.parent_unit_id IS NOT NULL THEN
    SELECT u.province_code INTO v_parent_province
      FROM public.authority_units u WHERE u.id = NEW.parent_unit_id;
    IF v_parent_province IS DISTINCT FROM NEW.province_code THEN
      RAISE EXCEPTION 'authority_units: the parent unit is in %, the unit in %',
        v_parent_province, NEW.province_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_units_shape ON public.authority_units;
CREATE TRIGGER authority_units_shape
  BEFORE INSERT OR UPDATE OR DELETE ON public.authority_units
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_authority_unit_shape();

DROP TRIGGER IF EXISTS authority_units_no_truncate ON public.authority_units;
CREATE TRIGGER authority_units_no_truncate
  BEFORE TRUNCATE ON public.authority_units
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_authority_unit_shape();

COMMENT ON TABLE public.authority_units IS
  'Who governs: a provincia, municipio, ciudad, comuna or departamento (localidades-por-id C1). Seeded as draft from INDEC departments (scripts/seed-authority-units.ts); a platform admin confirms each one. Never deleted.';

-- 2. authority_unit_localities -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.authority_unit_localities (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id      uuid        NOT NULL REFERENCES public.authority_units (id) ON DELETE RESTRICT,
  locality_id  uuid        NOT NULL REFERENCES public.ar_localities (id) ON DELETE RESTRICT,
  -- Copied from the unit by trigger: what the one-active-per-level index keys on.
  level        text        NOT NULL CHECK (level IN ('municipal', 'submunicipal')),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  -- Who opened and who closed the membership: a platform admin's profile id,
  -- or NULL for the seed script. No FK: a membership row outlives its actors.
  added_by     uuid,
  ended_by     uuid,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS authority_unit_localities_active_unique
  ON public.authority_unit_localities (locality_id, level) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS authority_unit_localities_locality_active_idx
  ON public.authority_unit_localities (locality_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS authority_unit_localities_unit_idx
  ON public.authority_unit_localities (unit_id);

CREATE OR REPLACE FUNCTION public.enforce_authority_unit_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_level     text;
  v_unit_province  text;
  v_locality_prov  text;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'authority_unit_localities: a membership is never deleted (% refused). Close it with valid_to.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.valid_to IS NOT NULL
       OR NEW.valid_to IS NULL
       OR NEW.id          IS DISTINCT FROM OLD.id
       OR NEW.unit_id     IS DISTINCT FROM OLD.unit_id
       OR NEW.locality_id IS DISTINCT FROM OLD.locality_id
       OR NEW.level       IS DISTINCT FROM OLD.level
       OR NEW.valid_from  IS DISTINCT FROM OLD.valid_from
       OR NEW.added_by    IS DISTINCT FROM OLD.added_by THEN
      RAISE EXCEPTION 'authority_unit_localities: only closing an active membership is allowed (valid_to, ended_by)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: a membership is born active, at its unit's level, in its province.
  IF NEW.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'authority_unit_localities: a membership is opened active; close it afterwards'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u.level, u.province_code INTO v_unit_level, v_unit_province
    FROM public.authority_units u WHERE u.id = NEW.unit_id;
  IF v_unit_level = 'provincial' THEN
    RAISE EXCEPTION 'authority_unit_localities: a provincial unit has no explicit members; it covers its whole province'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l.province_code INTO v_locality_prov
    FROM public.ar_localities l WHERE l.id = NEW.locality_id;
  IF v_locality_prov IS DISTINCT FROM v_unit_province THEN
    RAISE EXCEPTION 'authority_unit_localities: the locality belongs to %, the unit to %',
      v_locality_prov, v_unit_province
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.level := v_unit_level;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_unit_localities_shape ON public.authority_unit_localities;
CREATE TRIGGER authority_unit_localities_shape
  BEFORE INSERT OR UPDATE OR DELETE ON public.authority_unit_localities
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_authority_unit_membership();

DROP TRIGGER IF EXISTS authority_unit_localities_no_truncate ON public.authority_unit_localities;
CREATE TRIGGER authority_unit_localities_no_truncate
  BEFORE TRUNCATE ON public.authority_unit_localities
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_authority_unit_membership();

COMMENT ON TABLE public.authority_unit_localities IS
  'Which catalogue localities an authority unit governs, dated (localidades-por-id C1). Opened and closed, never rewritten or deleted: the rows are the audit trail. One active membership per (locality, level).';

-- 3. RLS -------------------------------------------------------------------------

ALTER TABLE public.authority_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authority_unit_localities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authority_units select by institutional" ON public.authority_units;
CREATE POLICY "authority_units select by institutional"
  ON public.authority_units
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role IN ('admin'::user_role, 'govt'::user_role))
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.authority_units;
CREATE POLICY "institutional sessions require aal2" ON public.authority_units
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

DROP POLICY IF EXISTS "authority_unit_localities select by institutional" ON public.authority_unit_localities;
CREATE POLICY "authority_unit_localities select by institutional"
  ON public.authority_unit_localities
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role IN ('admin'::user_role, 'govt'::user_role))
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.authority_unit_localities;
CREATE POLICY "institutional sessions require aal2" ON public.authority_unit_localities
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));
