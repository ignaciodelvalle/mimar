-- ────────────────────────────────────────────────────────────────────────────
-- 0268_jurisdiction_admin_appointments.sql
-- One delegated administrator per province (SDD jurisdiction-admin, M1).
--
-- WHAT (PO decision 2026-09-26, every product question closed)
-- ---------------------------------------------------------------------------
-- The platform admin appoints ONE jurisdiction administrator per province
-- (CABA counts as one). Inside that province the appointee creates and
-- deactivates funcionarios, grants and confirms units and edits the local
-- rules; outside it they can do nothing, and they never raise their own
-- permissions. The appointee is ALSO a province-wide funcionario: the
-- appointment carries a real whole-province govt_assignments grant (design
-- D1), so reads, powers and history all come from rows that already exist.
--
-- A jurisdiction admin is therefore:
--     profiles.role = 'govt'  (never 'admin' — no role='admin' site changes
--                              meaning, and a missing row can only NARROW)
--   + an ACTIVE row here
--   + that row's implied whole-province grant, still ACTIVE.
-- Absence or revocation of any part fails closed to plain govt (D2).
--
-- WHAT THIS FILE CREATES
-- ---------------------------------------------------------------------------
--   1. public.govt_grant_is_whole_province(province, locality) — the SQL twin
--      of isWholeProvinceLocality (lib/domain/jurisdiction-canonical.ts): the
--      '' sentinel, or CABA's INDEC whole-city entry.
--   2. public.jurisdiction_admin_appointments — append-only: DELETE and
--      TRUNCATE refused; UPDATE may only revoke, once, by the platform admin.
--      Two partial unique indexes: one active appointment per province, one
--      per user.
--   3. An INSERT validator: appointed by the platform admin; the appointee is
--      an active institutional govt; the implied grant is theirs, active,
--      whole-province and of THIS province; the appointee holds no active
--      grant outside it (D3, single-province).
--   4. public.jurisdiction_admin_province(uuid) — the DATABASE TWIN of the app
--      authority module (src/modules/organizations/application/admin-authority/
--      authority.ts). One definition: every app guard calls it inside its
--      transaction, and every trigger and policy below asks it too (D4).
--      SECURITY DEFINER, search_path '', EXECUTE revoked from everyone but
--      the owner. public.jurisdiction_admin_province() — no argument — is the
--      auth.uid() wrapper RLS uses; it only ever answers for the caller.
--   5. RLS: SELECT of the own row, or by the platform admin; aal2 for any
--      institutional session; no write policy at all (the app writes as the
--      owner through Drizzle; RLS is the PostgREST backstop).
--   6. A govt_assignments guard (the DB belt behind every grant writer):
--        a. a grant OUTSIDE the appointee's province is refused (insert or
--           un-revocation) while the appointment is active;
--        b. the implied grant cannot be revoked while its appointment is
--           active — revoke the appointment first, in the same transaction;
--        c. when the ACTOR of a grant or of a revocation (granted_by /
--           revoked_by) holds an active appointment, the grant's province
--           must be the actor's own.
--
-- FAIL-CLOSED READING OF THE TWIN (D2). jurisdiction_admin_province(u) is the
-- province only when ALL of these hold, and NULL otherwise:
--   appointment active · implied grant active, the user's own, whole-province
--   and of that province · if the grant was moved onto a unit, that unit is
--   the province's CONFIRMED provincia unit (a draft covers nothing, 0260) ·
--   no active grant of the user outside the province · the profile is an
--   active, non-erased institutional govt.
--
-- PRIVACY. An official act about a public official: the appointee FK and the
-- operator's reasons. Classified next to govt_assignments in
-- scripts/check-subject-rights-coverage.ts (the same gap: neither RPC reaches
-- it) and in docs/architecture/rls-coverage.md.
--
-- Idempotent. Forward-only. Ends in a post-condition that raises (0260).
-- Rollback: revoke every appointment (instant — authority reverts to the
-- platform admin alone); the objects are additive.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Whole-province predicate ------------------------------------------------

CREATE OR REPLACE FUNCTION public.govt_grant_is_whole_province(p_province text, p_locality text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(
    public.ar_province_code(p_province) IS NOT NULL
    AND p_locality IS NOT NULL
    AND (
      p_locality = ''
      OR (p_province = 'CABA' AND p_locality = 'Ciudad Autónoma de Buenos Aires')
    ),
    false)
$$;

COMMENT ON FUNCTION public.govt_grant_is_whole_province(text, text) IS
  'SQL twin of isWholeProvinceLocality (lib/domain/jurisdiction-canonical.ts): the '''' sentinel, or CABA''s INDEC whole-city entry. Never NULL.';

-- 2. The table ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jurisdiction_admin_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  province_code text NOT NULL,
  govt_assignment_id uuid NOT NULL REFERENCES public.govt_assignments(id) ON DELETE RESTRICT,
  grant_created boolean NOT NULL,
  appointed_by_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  appointment_reason text NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revocation_reason text,
  CONSTRAINT jurisdiction_admin_appointments_province_valid
    CHECK (public.ar_province_name(province_code) IS NOT NULL),
  CONSTRAINT jurisdiction_admin_appointments_reason_len
    CHECK (char_length(btrim(appointment_reason)) BETWEEN 1 AND 500),
  CONSTRAINT jurisdiction_admin_appointments_revocation_shape CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revoked_by_user_id IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND char_length(btrim(revocation_reason)) BETWEEN 1 AND 500
    )
  )
);

COMMENT ON TABLE public.jurisdiction_admin_appointments IS
  'One delegated jurisdiction administrator per province (0268). Append-only: revoked once, never deleted or rewritten; re-appointing is a new row. Authority is read ONLY through public.jurisdiction_admin_province(uuid).';

CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_admin_appointments_one_active_per_province
  ON public.jurisdiction_admin_appointments (province_code)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_admin_appointments_one_active_per_user
  ON public.jurisdiction_admin_appointments (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS jurisdiction_admin_appointments_grant_idx
  ON public.jurisdiction_admin_appointments (govt_assignment_id);

-- 3. Append-only + revocation shape ---------------------------------------------

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_appointments_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'jurisdiction_admin_append_only: an appointment is revoked, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- UPDATE: only the revocation, only once, only the three revoked_* columns.
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'jurisdiction_admin_append_only: appointment % is already revoked', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'jurisdiction_admin_append_only: the only change an appointment admits is its revocation'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason']) THEN
    RAISE EXCEPTION 'jurisdiction_admin_append_only: a revocation may not rewrite the appointment'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Only the platform admin revokes (spec: appointment and revocation are
  -- platform-admin-only). A jurisdiction admin is role govt and never passes.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.revoked_by_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'jurisdiction_admin_platform_only: only the platform admin revokes an appointment'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jurisdiction_admin_appointments_append_only
  ON public.jurisdiction_admin_appointments;
CREATE TRIGGER jurisdiction_admin_appointments_append_only
  BEFORE UPDATE OR DELETE ON public.jurisdiction_admin_appointments
  FOR EACH ROW EXECUTE FUNCTION public.jurisdiction_admin_appointments_append_only();

DROP TRIGGER IF EXISTS jurisdiction_admin_appointments_no_truncate
  ON public.jurisdiction_admin_appointments;
CREATE TRIGGER jurisdiction_admin_appointments_no_truncate
  BEFORE TRUNCATE ON public.jurisdiction_admin_appointments
  FOR EACH STATEMENT EXECUTE FUNCTION public.jurisdiction_admin_appointments_append_only();

-- 4. INSERT validation ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_appointments_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_grant record;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'jurisdiction_admin_append_only: an appointment is born active'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.appointed_by_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'jurisdiction_admin_platform_only: only the platform admin appoints'
      USING ERRCODE = '42501';
  END IF;

  -- FOR SHARE: a concurrent deactivation or grant revocation waits for this
  -- transaction instead of committing under it.
  PERFORM 1 FROM public.profiles p
    WHERE p.id = NEW.user_id
      AND p.role = 'govt'
      AND p.account_type = 'institutional'
      AND p.deactivated_at IS NULL
      AND p.deleted_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jurisdiction_admin_appointee_invalid: the appointee must be an active institutional govt'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT g.user_id, g.jurisdiction_province, g.jurisdiction_locality, g.revoked_at,
         g.authority_unit_id
    INTO v_grant
    FROM public.govt_assignments g
   WHERE g.id = NEW.govt_assignment_id
   FOR SHARE;
  IF NOT FOUND
     OR v_grant.user_id <> NEW.user_id
     OR v_grant.revoked_at IS NOT NULL
     OR public.ar_province_code(v_grant.jurisdiction_province) IS DISTINCT FROM NEW.province_code
     OR NOT public.govt_grant_is_whole_province(v_grant.jurisdiction_province,
                                                v_grant.jurisdiction_locality) THEN
    RAISE EXCEPTION 'jurisdiction_admin_grant_invalid: the implied grant must be the appointee''s own ACTIVE whole-province grant of %', NEW.province_code
      USING ERRCODE = 'check_violation';
  END IF;

  -- D3: single-province. A user with an active grant elsewhere is refused.
  IF EXISTS (
    SELECT 1 FROM public.govt_assignments o
     WHERE o.user_id = NEW.user_id
       AND o.revoked_at IS NULL
       AND public.ar_province_code(o.jurisdiction_province) IS DISTINCT FROM NEW.province_code
  ) THEN
    RAISE EXCEPTION 'jurisdiction_admin_foreign_grant: the appointee holds an active grant outside %', NEW.province_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jurisdiction_admin_appointments_validate
  ON public.jurisdiction_admin_appointments;
CREATE TRIGGER jurisdiction_admin_appointments_validate
  BEFORE INSERT ON public.jurisdiction_admin_appointments
  FOR EACH ROW EXECUTE FUNCTION public.jurisdiction_admin_appointments_validate();

-- 5. The database twin of the authority module ---------------------------------

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_province(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.province_code
    FROM public.jurisdiction_admin_appointments a
    JOIN public.govt_assignments g ON g.id = a.govt_assignment_id
    JOIN public.profiles p ON p.id = a.user_id
   WHERE a.user_id = p_user
     AND a.revoked_at IS NULL
     AND g.user_id = a.user_id
     AND g.revoked_at IS NULL
     AND public.ar_province_code(g.jurisdiction_province) = a.province_code
     AND public.govt_grant_is_whole_province(g.jurisdiction_province, g.jurisdiction_locality)
     AND (
       g.authority_unit_id IS NULL
       OR EXISTS (
         SELECT 1 FROM public.authority_units u
          WHERE u.id = g.authority_unit_id
            AND u.kind = 'provincia'
            AND u.status = 'confirmed'
            AND u.province_code = a.province_code
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.govt_assignments o
        WHERE o.user_id = a.user_id
          AND o.revoked_at IS NULL
          AND public.ar_province_code(o.jurisdiction_province) IS DISTINCT FROM a.province_code
     )
     AND p.role = 'govt'
     AND p.account_type = 'institutional'
     AND p.deactivated_at IS NULL
     AND p.deleted_at IS NULL
   LIMIT 1
$$;

COMMENT ON FUNCTION public.jurisdiction_admin_province(uuid) IS
  'The province a user administers as jurisdiction admin, or NULL (0268, design D2/D4). NULL unless: appointment active, implied grant active/own/whole-province/of that province (a unit-bound grant only on the CONFIRMED provincia unit), no active grant elsewhere, profile an active non-erased institutional govt. The app authority module calls it inside the writer''s transaction; triggers and policies ask it too. EXECUTE: owner only.';

REVOKE EXECUTE ON FUNCTION public.jurisdiction_admin_province(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_province()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.jurisdiction_admin_province((SELECT auth.uid()))
$$;

COMMENT ON FUNCTION public.jurisdiction_admin_province() IS
  'jurisdiction_admin_province(auth.uid()) for RLS: answers only for the caller.';

REVOKE EXECUTE ON FUNCTION public.jurisdiction_admin_province() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jurisdiction_admin_province() TO authenticated;

-- 6. RLS --------------------------------------------------------------------------

ALTER TABLE public.jurisdiction_admin_appointments ENABLE ROW LEVEL SECURITY;

-- No write path through PostgREST, not even by accident of a future policy.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.jurisdiction_admin_appointments
  FROM anon, authenticated;

DROP POLICY IF EXISTS "jurisdiction_admin_appointments select own or platform admin"
  ON public.jurisdiction_admin_appointments;
CREATE POLICY "jurisdiction_admin_appointments select own or platform admin"
  ON public.jurisdiction_admin_appointments
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (SELECT auth.uid())
         AND p.role = 'admin'::user_role
         AND p.account_type = 'institutional'::text
         AND p.deactivated_at IS NULL
         AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.jurisdiction_admin_appointments;
CREATE POLICY "institutional sessions require aal2" ON public.jurisdiction_admin_appointments
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.caller_meets_institutional_aal()));

-- 7. govt_assignments guard -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.govt_assignments_jurisdiction_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row_province text := public.ar_province_code(NEW.jurisdiction_province);
  v_holder_province text;
  v_actor uuid;
  v_actor_province text;
BEGIN
  -- b. The implied grant is revoked only AFTER its appointment: revoke the
  --    appointment first, then the grant, in the same transaction.
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.jurisdiction_admin_appointments a
        WHERE a.govt_assignment_id = NEW.id AND a.revoked_at IS NULL
     ) THEN
    RAISE EXCEPTION 'jurisdiction_admin_implied_grant_active: revoke the appointment before its implied grant %', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- a. No active grant outside the appointee's province (D3).
  IF NEW.revoked_at IS NULL THEN
    SELECT a.province_code INTO v_holder_province
      FROM public.jurisdiction_admin_appointments a
     WHERE a.user_id = NEW.user_id AND a.revoked_at IS NULL;
    IF v_holder_province IS NOT NULL
       AND v_row_province IS DISTINCT FROM v_holder_province THEN
      RAISE EXCEPTION 'jurisdiction_admin_foreign_grant: % administers % and cannot hold a grant in %',
        NEW.user_id, v_holder_province, coalesce(v_row_province, '<none>')
      USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- c. An appointee who grants or revokes acts only inside their province.
  v_actor := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.granted_by_user_id
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN NEW.revoked_by_user_id
    ELSE NULL
  END;
  IF v_actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.jurisdiction_admin_appointments a
     WHERE a.user_id = v_actor AND a.revoked_at IS NULL
  ) THEN
    v_actor_province := public.jurisdiction_admin_province(v_actor);
    IF v_actor_province IS NULL OR v_row_province IS DISTINCT FROM v_actor_province THEN
      RAISE EXCEPTION 'jurisdiction_admin_out_of_province: % cannot act on a grant in %',
        v_actor, coalesce(v_row_province, '<none>')
      USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS govt_assignments_jurisdiction_admin_guard ON public.govt_assignments;
CREATE TRIGGER govt_assignments_jurisdiction_admin_guard
  BEFORE INSERT OR UPDATE ON public.govt_assignments
  FOR EACH ROW EXECUTE FUNCTION public.govt_assignments_jurisdiction_admin_guard();

-- 8. Post-condition ---------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'jurisdiction_admin_appointments'
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Migration 0268 did not close: jurisdiction_admin_appointments missing or without RLS';
  END IF;

  IF (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'jurisdiction_admin_appointments'
         AND indexname IN ('jurisdiction_admin_appointments_one_active_per_province',
                           'jurisdiction_admin_appointments_one_active_per_user')
         AND indexdef LIKE 'CREATE UNIQUE INDEX%'
         AND indexdef LIKE '%WHERE (revoked_at IS NULL)%') <> 2 THEN
    RAISE EXCEPTION 'Migration 0268 did not close: the two partial unique indexes (one active appointment per province, per user) are not both live';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND (t.tgrelid, t.tgname) IN (
           ('public.jurisdiction_admin_appointments'::regclass, 'jurisdiction_admin_appointments_append_only'),
           ('public.jurisdiction_admin_appointments'::regclass, 'jurisdiction_admin_appointments_no_truncate'),
           ('public.jurisdiction_admin_appointments'::regclass, 'jurisdiction_admin_appointments_validate'),
           ('public.govt_assignments'::regclass, 'govt_assignments_jurisdiction_admin_guard')
         )) <> 4 THEN
    RAISE EXCEPTION 'Migration 0268 did not close: an append-only, validation or grant-guard trigger is missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'jurisdiction_admin_province'
       AND pg_get_function_identity_arguments(p.oid) = 'p_user uuid'
       AND p.prosecdef AND p.provolatile = 's'
       AND p.proconfig @> ARRAY['search_path=""']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND p.prosrc LIKE '%a.revoked_at IS NULL%'
       AND p.prosrc LIKE '%g.revoked_at IS NULL%'
       AND p.prosrc LIKE '%p.deleted_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'Migration 0268 did not close: jurisdiction_admin_province(uuid) must be STABLE SECURITY DEFINER, search_path '''', owner-only EXECUTE, and read both revocations and the erasure marker';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'jurisdiction_admin_province'
       AND pg_get_function_identity_arguments(p.oid) = ''
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Migration 0268 did not close: jurisdiction_admin_province() must be SECURITY DEFINER, search_path '''', not anon-executable';
  END IF;
END
$$;
