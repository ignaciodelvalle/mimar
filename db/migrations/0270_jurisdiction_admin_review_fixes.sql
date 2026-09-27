-- ────────────────────────────────────────────────────────────────────────────
-- 0270_jurisdiction_admin_review_fixes.sql
-- Findings of the Phase-2 security review of 0268 + 0269 (SDD
-- jurisdiction-admin), closed at the database, forward-only.
--
-- M2 — FAIL CLOSED FOR EVERY ACTOR, NOT ONLY FOR APPOINTEES
-- ---------------------------------------------------------------------------
-- 0268/0269 checked a delegated act only when the actor HELD an active
-- appointment row. A plain govt (no appointment at all) writing a delegated
-- act passed the database untouched, and the app was the only wall. Now:
--   - audit_log_province_guard: a DELEGATED action whose actor is not null and
--     not the platform admin needs a live jurisdiction admin (the twin
--     answers); with no appointment at all it raises
--     `jurisdiction_admin_no_authority`. A null actor (a system writer) is
--     unchanged.
--   - govt_assignments guard: a grant INSERTED by a non-null granter who is
--     neither the platform admin nor a live jurisdiction admin is refused the
--     same way. A REVOCATION is not: a plain govt legitimately revokes by the
--     existing rank rule (revoke-govt-locality) and every govt revokes its own
--     grants when it resigns — those paths are not administration.
--   - govt_business_rules guard: a rule stamped (created_by on insert,
--     updated_by on insert or when an update CHANGES it) by a non-null actor
--     who is neither the platform admin nor a live jurisdiction admin is
--     refused. An update that leaves updated_by as it was is not a new act by
--     that person, so a later system rewrite of an old rule is not refused on
--     behalf of an author who has since left.
--
-- L3 — THE AUDIT HELPERS ARE NOT AN API
-- ---------------------------------------------------------------------------
-- audit_try_uuid, audit_as_province_code, audit_row_place_codes,
-- audit_target_user_provinces and audit_row_province were executable by
-- PUBLIC (and Supabase's default privileges grant anon/authenticated
-- explicitly). They are only ever called by the owner: the SECURITY DEFINER
-- audit guard, the SECURITY DEFINER RLS helper, and the app (Drizzle, as the
-- owner). EXECUTE is revoked from PUBLIC, anon and authenticated; the
-- post-condition asserts it. Inlining is unaffected: the planner inlines for
-- a role that holds EXECUTE, and every caller runs as the owner.
--
-- SELF-RESIGNATION (needed by L5)
-- ---------------------------------------------------------------------------
-- A govt who resigns (govt-self-deactivate) revokes every grant it holds. An
-- appointee's implied grant cannot be revoked while its appointment is active
-- (0268, guard b), so the resignation must revoke the appointment first — by
-- the appointee. The append-only trigger now admits exactly that second
-- revoker: the appointee themself. It only ever NARROWS authority (the
-- appointee loses it); no one else but the platform admin may revoke.
--
-- L1 — rule DELETE (app side). The writer now writes its audit row BEFORE the
-- delete, so the guard reads the live row through `ruleId`, and the payload
-- snapshot carries authority_unit_id + locality_id. No BEFORE DELETE trigger:
-- a delete carries no actor column, and every test cleanup and FK cascade
-- deletes rules with no actor — the only way to tell them apart would be an
-- escape hatch that is itself the bypass.
--
-- TODO(M1, security review of 0269): the audit_log READ branch ("audit log
-- visible to the jurisdiction admin of its province") is deliberately left
-- as 0269 wrote it until the PO decides the privacy question the review
-- raised. Do not change it here.
--
-- Idempotent (CREATE OR REPLACE, REVOKE). Forward-only. Ends in a
-- post-condition that raises (0260).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Append-only: the platform admin, or the appointee resigning ------------------

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

  -- The platform admin revokes; the appointee may only resign (0270). Any
  -- other govt — another appointee included — never passes.
  IF NEW.revoked_by_user_id IS DISTINCT FROM OLD.user_id AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.revoked_by_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'jurisdiction_admin_platform_only: only the platform admin revokes an appointment (the appointee may only resign)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- 2. govt_assignments guard: a granter needs authority (M2) ---------------------

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

  -- c. The actor of a grant or of a revocation.
  v_actor := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.granted_by_user_id
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN NEW.revoked_by_user_id
    ELSE NULL
  END;
  IF v_actor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = v_actor
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.jurisdiction_admin_appointments a
       WHERE a.user_id = v_actor AND a.revoked_at IS NULL
    ) THEN
      -- An appointee grants or revokes only inside their province.
      v_actor_province := public.jurisdiction_admin_province(v_actor);
      IF v_actor_province IS NULL OR v_row_province IS DISTINCT FROM v_actor_province THEN
        RAISE EXCEPTION 'jurisdiction_admin_out_of_province: % cannot act on a grant in %',
          v_actor, coalesce(v_row_province, '<none>')
        USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'INSERT' THEN
      -- M2: nobody else grants. (A revocation stays open: the govt rank rule
      -- and a govt's own resignation revoke grants without administering.)
      RAISE EXCEPTION 'jurisdiction_admin_no_authority: % is neither the platform admin nor a jurisdiction admin and cannot grant',
        v_actor
      USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 3. govt_business_rules guard: an author needs authority (M2) -----------------

CREATE OR REPLACE FUNCTION public.govt_business_rules_jurisdiction_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_actor_province text;
  v_codes text[];
BEGIN
  FOR v_actor IN
    SELECT DISTINCT x
      FROM unnest(ARRAY[
        CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by_user_id END,
        NEW.updated_by_user_id]) AS x
     WHERE x IS NOT NULL
  LOOP
    -- The platform admin writes any rule, country-wide included.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = v_actor
         AND p.role = 'admin'
         AND p.account_type = 'institutional'
         AND p.deactivated_at IS NULL
         AND p.deleted_at IS NULL);

    IF NOT EXISTS (
      SELECT 1 FROM public.jurisdiction_admin_appointments a
       WHERE a.user_id = v_actor AND a.revoked_at IS NULL) THEN
      -- M2: no authority at all. Refused when this row names them as the
      -- author of THIS write; an untouched updated_by is not a new act.
      IF TG_OP = 'INSERT' OR NEW.updated_by_user_id IS DISTINCT FROM OLD.updated_by_user_id THEN
        RAISE EXCEPTION 'jurisdiction_admin_no_authority: % is neither the platform admin nor a jurisdiction admin and cannot write a rule',
          v_actor
        USING ERRCODE = '42501';
      END IF;
      CONTINUE;
    END IF;

    v_actor_province := public.jurisdiction_admin_province(v_actor);
    v_codes := public.govt_business_rule_place_codes(
      NEW.authority_unit_id, NEW.locality_id, NEW.jurisdiction_province);
    IF TG_OP = 'UPDATE' THEN
      v_codes := v_codes || public.govt_business_rule_place_codes(
        OLD.authority_unit_id, OLD.locality_id, OLD.jurisdiction_province);
    END IF;
    IF cardinality(v_codes) = 0 THEN
      RAISE EXCEPTION 'jurisdiction_admin_country_wide: % cannot write a country-wide rule', v_actor
      USING ERRCODE = '42501';
    END IF;
    IF v_actor_province IS NULL
       OR EXISTS (SELECT 1 FROM unnest(v_codes) c WHERE c IS DISTINCT FROM v_actor_province) THEN
      RAISE EXCEPTION 'jurisdiction_admin_out_of_province: % cannot write a rule in %',
        v_actor, array_to_string(v_codes, ',')
      USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- 4. audit_log guard: a delegated act needs authority (M2) ---------------------

CREATE OR REPLACE FUNCTION public.audit_log_province_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Acts only the platform admin performs. Never delegated.
  c_platform_only CONSTANT text[] := ARRAY[
    'admin_deactivated_by_admin',
    'authority_unit_unconfirmed',
    'govt_assignment_unit_unconfirmed',
    'govt_reactivated_by_admin',
    'institutional_admin_created',
    'institutional_national_created',
    'jurisdiction_admin_appointed',
    'jurisdiction_admin_revoked',
    'mfa_factors_reset_by_admin',
    'operator_credentials_reset'
  ];
  -- Acts a jurisdiction admin may perform, inside their province only. Any
  -- other actor but the platform admin (or a system writer) is refused.
  c_delegated CONSTANT text[] := ARRAY[
    'authority_unit_confirmed',
    'authority_unit_created',
    'authority_unit_membership_moved',
    'authority_unit_membership_removed',
    'authority_unit_renamed',
    'govt_assignment_unit_confirmed',
    'govt_business_rule_created',
    'govt_business_rule_deleted',
    'govt_business_rule_updated',
    'govt_deactivated_by_admin',
    'govt_locality_assigned',
    'institutional_govt_created'
  ];
  v_actor_is_platform boolean;
  v_row_codes text[];
  v_target_codes text[] := ARRAY[]::text[];
  v_all_codes text[];
  v_actor_codes text[];
  v_derived text;
  v_actor_province text;
BEGIN
  v_actor_is_platform := NEW.actor_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.actor_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  );

  -- c. Platform-only acts.
  IF NEW.action = ANY (c_platform_only) AND NOT v_actor_is_platform THEN
    RAISE EXCEPTION 'jurisdiction_admin_platform_only: % is performed by the platform admin only', NEW.action
      USING ERRCODE = '42501';
  END IF;

  -- a. Derive the place: a single province the row names, else a single
  --    province of the target's grants, else the actor's single province.
  v_row_codes := public.audit_row_place_codes(NEW.payload, NEW.target_govt_assignment_id);
  IF cardinality(v_row_codes) = 0 AND NEW.target_user_id IS NOT NULL THEN
    v_target_codes := public.audit_target_user_provinces(NEW.target_user_id, NEW.actor_user_id);
  END IF;
  IF cardinality(v_row_codes) = 1 THEN
    v_derived := v_row_codes[1];
  ELSIF cardinality(v_row_codes) = 0 THEN
    IF cardinality(v_target_codes) = 1 THEN
      v_derived := v_target_codes[1];
    ELSIF cardinality(v_target_codes) = 0 AND NEW.actor_user_id IS NOT NULL THEN
      v_actor_codes := ARRAY(
        SELECT DISTINCT public.ar_province_code(g.jurisdiction_province)
          FROM public.govt_assignments g
          JOIN public.profiles p ON p.id = g.user_id
         WHERE g.user_id = NEW.actor_user_id
           AND g.revoked_at IS NULL
           AND p.role = 'govt'
           AND p.deactivated_at IS NULL
           AND p.deleted_at IS NULL);
      IF cardinality(v_actor_codes) = 1 THEN
        v_derived := v_actor_codes[1];
      END IF;
    END IF;
  END IF;

  -- b. A supplied stamp must be the derived one; with nothing to derive it
  --    from, only the platform admin or a system writer (no actor) stamps.
  IF NEW.province_code IS NULL THEN
    NEW.province_code := v_derived;
  ELSIF v_derived IS NOT NULL THEN
    IF NEW.province_code <> v_derived THEN
      RAISE EXCEPTION 'audit_province_mismatch: % supplied, % derived', NEW.province_code, v_derived
      USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.actor_user_id IS NOT NULL AND NOT v_actor_is_platform THEN
    RAISE EXCEPTION 'audit_province_mismatch: % supplied with nothing to derive it from', NEW.province_code
      USING ERRCODE = 'check_violation';
  END IF;

  -- d. A delegated act by anyone but the platform admin or a system writer
  --    must be a live jurisdiction admin's, inside their province.
  IF NEW.action = ANY (c_delegated) AND NEW.actor_user_id IS NOT NULL
     AND NOT v_actor_is_platform THEN
    v_actor_province := public.jurisdiction_admin_province(NEW.actor_user_id);
    IF v_actor_province IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.jurisdiction_admin_appointments a
       WHERE a.user_id = NEW.actor_user_id AND a.revoked_at IS NULL
    ) THEN
      -- M2: no appointment at all — a plain govt, an owner, anyone.
      RAISE EXCEPTION 'jurisdiction_admin_no_authority: % by % — neither the platform admin nor a jurisdiction admin',
        NEW.action, NEW.actor_user_id
      USING ERRCODE = '42501';
    END IF;
    IF NEW.target_user_id IS NOT NULL THEN
      v_target_codes := public.audit_target_user_provinces(NEW.target_user_id, NEW.actor_user_id);
    END IF;
    v_all_codes := ARRAY(
      SELECT DISTINCT c FROM unnest(v_row_codes || v_target_codes) AS c ORDER BY c);
    IF v_actor_province IS NULL
       OR cardinality(v_all_codes) = 0
       OR v_all_codes <> ARRAY[v_actor_province]
       OR NEW.province_code IS DISTINCT FROM v_actor_province
       OR NEW.target_user_id = NEW.actor_user_id
       OR (NEW.target_user_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.jurisdiction_admin_appointments t
              WHERE t.user_id = NEW.target_user_id AND t.revoked_at IS NULL))
    THEN
      RAISE EXCEPTION 'jurisdiction_admin_out_of_province: % by % outside % (places: %)',
        NEW.action, NEW.actor_user_id, coalesce(v_actor_province, '<no authority>'),
        array_to_string(v_all_codes, ',')
      USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.audit_log_province_guard() FROM PUBLIC, anon, authenticated;

-- 5. L3: the audit helpers are owner-only ------------------------------------------

REVOKE EXECUTE ON FUNCTION public.audit_try_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_as_province_code(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_row_place_codes(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_target_user_provinces(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_row_province(public.audit_log) FROM PUBLIC, anon, authenticated;

-- 6. Post-condition ----------------------------------------------------------------

DO $$
DECLARE
  v_fn text;
BEGIN
  -- L3: none of the five helpers is executable by PUBLIC, anon or authenticated.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.audit_try_uuid(text)',
    'public.audit_as_province_code(text)',
    'public.audit_row_place_codes(jsonb, uuid)',
    'public.audit_target_user_provinces(uuid, uuid)',
    'public.audit_row_province(public.audit_log)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_proc p,
                LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = v_fn::regprocedure
            AND a.grantee = 0
            AND a.privilege_type = 'EXECUTE')
    THEN
      RAISE EXCEPTION 'Migration 0270 did not close: % is still executable by PUBLIC, anon or authenticated', v_fn;
    END IF;
  END LOOP;

  -- M2: the three guards refuse an actor with no authority at all.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('audit_log_province_guard',
                           'govt_assignments_jurisdiction_admin_guard',
                           'govt_business_rules_jurisdiction_admin_guard')
         AND p.prosrc LIKE '%jurisdiction_admin_no_authority%'
         AND p.proconfig @> ARRAY['search_path=""']) <> 3 THEN
    RAISE EXCEPTION 'Migration 0270 did not close: a guard does not refuse an actor with no authority (M2), or lost its pinned search_path';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'audit_log_province_guard'
       AND p.prosecdef
       AND p.prosrc LIKE '%jurisdiction_admin_province(NEW.actor_user_id)%'
       AND p.prosrc LIKE '%v_all_codes <> ARRAY[v_actor_province]%'
       AND p.prosrc LIKE '%NOT v_actor_is_platform THEN%'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Migration 0270 did not close: audit_log_province_guard must stay SECURITY DEFINER, compare every place against the actor''s province, and gate every non-platform delegated actor';
  END IF;

  -- The append-only trigger admits the platform admin and the appointee only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'jurisdiction_admin_appointments_append_only'
       AND p.prosrc LIKE '%NEW.revoked_by_user_id IS DISTINCT FROM OLD.user_id AND NOT EXISTS%'
       AND p.prosrc LIKE '%p.role = ''admin''%'
  ) THEN
    RAISE EXCEPTION 'Migration 0270 did not close: the appointment revoker must be the platform admin or the appointee themself';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND (t.tgrelid, t.tgname) IN (
           ('public.audit_log'::regclass, 'audit_log_province_guard'),
           ('public.govt_business_rules'::regclass, 'govt_business_rules_jurisdiction_admin_guard'),
           ('public.govt_assignments'::regclass, 'govt_assignments_jurisdiction_admin_guard'),
           ('public.jurisdiction_admin_appointments'::regclass, 'jurisdiction_admin_appointments_append_only')
         )) <> 4 THEN
    RAISE EXCEPTION 'Migration 0270 did not close: a guard trigger is missing or disabled';
  END IF;
END
$$;
