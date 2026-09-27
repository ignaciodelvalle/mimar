-- ────────────────────────────────────────────────────────────────────────────
-- 0269_audit_province_stamp.sql
-- Where each audited act happened, and the database backstop for every
-- delegated administrator's act (SDD jurisdiction-admin, M2).
--
-- WHY (PO decision 2026-09-26, CONFIRMED)
-- ---------------------------------------------------------------------------
-- A jurisdiction administrator reads the audit history of the acts that
-- happened IN their province, and that visibility survives the funcionario's
-- later deactivation or transfer. So the place is a fact of the ROW, stamped
-- once at insert and immutable (audit_log is append-only), never a live join
-- to where the person is now — a live join would move history with them.
--
-- And every delegated writer already writes its audit row in the same
-- transaction as its mutation, so ONE trigger here is the database twin of
-- every app guard (design D5): a refusal here rolls the mutation back.
--
-- WHAT THIS FILE DOES
-- ---------------------------------------------------------------------------
--   1. audit_log.province_code (nullable, CHECKed to one of the 24 codes) and
--      a partial index for the province history read.
--   2. Place derivation, in two strengths:
--        public.audit_row_place_codes(payload, target_govt_assignment_id)
--          — every province the ROW ITSELF names: payload unit_id /
--          to_unit_id / from_unit_id, locality_id, province / province_code,
--          jurisdiction.{province, localityId, authorityUnitId}, the ruleId's
--          stored place while the rule exists, and the target grant. Facts
--          that do not move with a person.
--        public.audit_target_user_provinces(target, actor) — the provinces of
--          the target user's grants that are ACTIVE, or were revoked by this
--          actor IN THIS TRANSACTION (revoked_at = now(): a deactivation
--          revokes and audits in one transaction, on the database clock —
--          deactivate-govt.ts writes revoked_at = now() for that reason).
--      public.audit_row_province(audit_log) = the stamp, else a SINGLE
--      province the row itself names (the read-time answer for rows written
--      before this migration; ambiguous or unplaced → NULL, fail-closed).
--   3. BEFORE INSERT trigger audit_log_province_guard:
--        a. stamp province_code when NULL: a single province the row names,
--           else a single province of the target's grants, else the
--           actor's single province when the actor is a govt;
--        b. a province_code the writer supplied must equal that derivation;
--           with nothing to derive from, only the platform admin (or a
--           system writer with no actor) may supply one;
--        c. PLATFORM_ONLY actions from anyone but the platform admin raise;
--        d. an actor holding an ACTIVE appointment who writes a DELEGATED
--           action must be a valid jurisdiction admin (the twin answers),
--           every place the row names must be their province and at least
--           one must exist, the target is never themself and never another
--           appointee — else `jurisdiction_admin_out_of_province`.
--   4. The action CHECK rewritten whole from AUDIT_LOG_ACTIONS (db/schema.ts),
--      alphabetically, the way 0265 did, adding:
--        jurisdiction_admin_appointed, jurisdiction_admin_revoked,
--        authority_unit_unconfirmed, govt_assignment_unit_unconfirmed,
--        govt_reactivated_by_admin (no reactivation writer exists yet — the
--        platform admin's reversal of a delegated deactivation needs one).
--   5. A govt_business_rules guard: when created_by / updated_by holds an
--      active appointment, every place the rule names (unit, locality,
--      province) — before AND after an update — must be their province, and
--      a country-wide rule (no place at all) is refused.
--   6. audit_log RLS: a permissive SELECT branch for the jurisdiction admin
--      of the row's province. The existing actor/admin policy and the aal2
--      restrictive policy are untouched.
--
-- NO BACKFILL. audit_log is append-only (enforce_audit_log_append_only): old
-- rows keep province_code NULL and are read through audit_row_province —
-- payload-derived or hidden, never guessed from where a person is today.
--
-- Idempotent. Forward-only. Ends in a post-condition that raises (0260).
-- Rollback: a forward migration dropping the trigger and the policy; the
-- column is additive and stays.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Column + index ---------------------------------------------------------------

ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS province_code text;

ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_province_code_valid;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_province_code_valid
  CHECK (province_code IS NULL OR public.ar_province_name(province_code) IS NOT NULL)
  NOT VALID;
ALTER TABLE public.audit_log VALIDATE CONSTRAINT audit_log_province_code_valid;

CREATE INDEX IF NOT EXISTS audit_log_province_idx
  ON public.audit_log (province_code, performed_at)
  WHERE province_code IS NOT NULL;

-- The target-user derivation reads a user's grants INCLUDING revoked ones;
-- every existing user_id index is partial on revoked_at IS NULL.
CREATE INDEX IF NOT EXISTS govt_assignments_user_idx
  ON public.govt_assignments (user_id);

-- 2. Place derivation ------------------------------------------------------------
--
-- PERFORMANCE (measured, see the change's apply report). This runs on EVERY
-- audit insert, so:
--   - the two tiny helpers are IMMUTABLE SQL with NO `SET search_path`, which
--     lets the planner inline them (a SET clause forbids inlining and costs a
--     GUC save/restore per call). Every name inside is schema-qualified, the
--     same reasoning 0257/0260 give for public.govt_scope;
--   - the derivation functions are plpgsql (their plans are cached per
--     session; a non-inlined SQL function is re-planned on every call);
--   - the payload lookups only run when the payload carries a place key.
-- The first draft of this file — SQL functions, each with SET search_path —
-- cost ~0.65–0.9 ms per insert over a bare ~0.2 ms insert.

CREATE OR REPLACE FUNCTION public.audit_try_uuid(p_text text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN p_text::uuid
  END
$$;

-- A province given as a display name ('Córdoba') or as a code ('AR-X').
CREATE OR REPLACE FUNCTION public.audit_as_province_code(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(
    public.ar_province_code(p_text),
    CASE WHEN public.ar_province_name(p_text) IS NOT NULL THEN p_text END)
$$;

CREATE OR REPLACE FUNCTION public.audit_row_place_codes(
  p_payload jsonb,
  p_target_govt_assignment_id uuid
)
RETURNS text[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_codes text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(p_payload) = 'object'
     AND p_payload ?| ARRAY['unit_id', 'to_unit_id', 'from_unit_id', 'locality_id', 'province',
                            'province_code', 'jurisdiction', 'ruleId'] THEN
    SELECT coalesce(array_agg(s.code), ARRAY[]::text[])
      INTO v_codes
      FROM (
        SELECT u.province_code AS code
          FROM public.authority_units u
         WHERE u.id IN (
           public.audit_try_uuid(p_payload ->> 'unit_id'),
           public.audit_try_uuid(p_payload ->> 'to_unit_id'),
           public.audit_try_uuid(p_payload ->> 'from_unit_id'),
           public.audit_try_uuid(p_payload -> 'jurisdiction' ->> 'authorityUnitId'))
        UNION ALL
        SELECT l.province_code
          FROM public.ar_localities l
         WHERE l.id IN (
           public.audit_try_uuid(p_payload ->> 'locality_id'),
           public.audit_try_uuid(p_payload -> 'jurisdiction' ->> 'localityId'))
        UNION ALL
        SELECT public.audit_as_province_code(p_payload -> 'jurisdiction' ->> 'province')
        UNION ALL
        SELECT public.audit_as_province_code(p_payload ->> 'province')
        UNION ALL
        SELECT public.audit_as_province_code(p_payload ->> 'province_code')
        UNION ALL
        -- The rule's stored place while the row exists (create, update). A
        -- deleted rule is gone before its audit row: its payload carries the
        -- jurisdiction snapshot the writer took from the row.
        SELECT x.code
          FROM public.govt_business_rules r
          CROSS JOIN LATERAL (VALUES
            ((SELECT u.province_code FROM public.authority_units u WHERE u.id = r.authority_unit_id)),
            ((SELECT l.province_code FROM public.ar_localities l WHERE l.id = r.locality_id)),
            (public.ar_province_code(r.jurisdiction_province))
          ) AS x(code)
         WHERE r.id = public.audit_try_uuid(p_payload ->> 'ruleId')
      ) s
     WHERE s.code IS NOT NULL;
  END IF;

  IF p_target_govt_assignment_id IS NOT NULL THEN
    v_codes := v_codes || ARRAY(
      SELECT public.ar_province_code(g.jurisdiction_province)
        FROM public.govt_assignments g
       WHERE g.id = p_target_govt_assignment_id
         AND public.ar_province_code(g.jurisdiction_province) IS NOT NULL);
  END IF;

  IF cardinality(v_codes) <= 1 THEN
    RETURN v_codes;
  END IF;
  RETURN ARRAY(SELECT DISTINCT c FROM unnest(v_codes) AS c ORDER BY c);
END
$$;

COMMENT ON FUNCTION public.audit_row_place_codes(jsonb, uuid) IS
  'Every province an audit row itself names (payload places, the rule''s stored place, the target grant), sorted, distinct. Facts that do not move with a person (0269). No SET search_path on purpose (per-insert cost); every name is schema-qualified.';

CREATE OR REPLACE FUNCTION public.audit_target_user_provinces(p_target uuid, p_actor uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN ARRAY(
    SELECT DISTINCT public.ar_province_code(g.jurisdiction_province) AS code
      FROM public.govt_assignments g
     WHERE g.user_id = p_target
       AND public.ar_province_code(g.jurisdiction_province) IS NOT NULL
       AND (
         g.revoked_at IS NULL
         OR (p_actor IS NOT NULL AND g.revoked_by_user_id = p_actor AND g.revoked_at = now())
       )
     ORDER BY 1);
END
$$;

COMMENT ON FUNCTION public.audit_target_user_provinces(uuid, uuid) IS
  'Provinces of a user''s grants that are active, or were revoked by p_actor in the current transaction (revoked_at = now()). Used only when stamping a new audit row (0269). No SET search_path on purpose; every name is schema-qualified.';

CREATE OR REPLACE FUNCTION public.audit_row_province(p_row public.audit_log)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    p_row.province_code,
    (SELECT CASE WHEN cardinality(c.codes) = 1 THEN c.codes[1] END
       FROM (SELECT public.audit_row_place_codes(p_row.payload, p_row.target_govt_assignment_id)
                    AS codes) c))
$$;

COMMENT ON FUNCTION public.audit_row_province(public.audit_log) IS
  'The province an audit row belongs to: its stamp, else the single province the row itself names; ambiguous or unplaced rows are NULL — visible to the platform admin only (0269).';

-- 3. The BEFORE INSERT guard -----------------------------------------------------

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
  -- Acts a jurisdiction admin may perform, inside their province only.
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
  v_row_codes text[];
  v_target_codes text[] := ARRAY[]::text[];
  v_all_codes text[];
  v_actor_codes text[];
  v_derived text;
  v_actor_province text;
BEGIN
  -- c. Platform-only acts.
  IF NEW.action = ANY (c_platform_only) AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.actor_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
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
  ELSIF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = NEW.actor_user_id
       AND p.role = 'admin'
       AND p.account_type = 'institutional'
       AND p.deactivated_at IS NULL
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'audit_province_mismatch: % supplied with nothing to derive it from', NEW.province_code
      USING ERRCODE = 'check_violation';
  END IF;

  -- d. A delegated act by a jurisdiction admin stays inside their province.
  IF NEW.action = ANY (c_delegated) AND EXISTS (
    SELECT 1 FROM public.jurisdiction_admin_appointments a
     WHERE a.user_id = NEW.actor_user_id AND a.revoked_at IS NULL
  ) THEN
    v_actor_province := public.jurisdiction_admin_province(NEW.actor_user_id);
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

COMMENT ON FUNCTION public.audit_log_province_guard() IS
  'audit_log BEFORE INSERT (0269): stamps province_code, refuses a mismatched stamp, refuses platform-only acts from anyone but the platform admin, and keeps every delegated act of a jurisdiction admin inside their province. The database twin of every delegated writer''s app guard.';

REVOKE EXECUTE ON FUNCTION public.audit_log_province_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_log_province_guard ON public.audit_log;
CREATE TRIGGER audit_log_province_guard
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_province_guard();

-- 4. The action CHECK, rewritten whole from AUDIT_LOG_ACTIONS ---------------------

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_valid;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_valid
  CHECK (action IN (
    'admin_deactivated_by_admin',
    'admin_seeded',
    'adopter_pii_viewed',
    'adoption_application_resolved',
    'adoption_application_submitted',
    'analytics_export_generated',
    'approval_request_withdrawn_by_applicant',
    'approval_request_withdrawn_by_system',
    'audit_log_mutation_override',
    'authority_unit_confirmed',
    'authority_unit_created',
    'authority_unit_membership_moved',
    'authority_unit_membership_removed',
    'authority_unit_renamed',
    'authority_unit_unconfirmed',
    'bite_reported_by_org',
    'capability_denied',
    'capability_granted',
    'capability_revoked',
    'caretaker_designated',
    'caretaker_grant_accepted',
    'caretaker_grant_cancelled',
    'caretaker_grant_rejected',
    'caretaker_grant_revoked',
    'caretaker_grant_withdrawn',
    'case_closed_manually',
    'case_escalated_manually',
    'case_events_mutation_override',
    'case_note_recorded',
    'claim_dispute_submitted',
    'cross_org_transfer_accepted',
    'cross_org_transfer_auto_expired',
    'cross_org_transfer_cancelled_by_sender',
    'cross_org_transfer_proposed',
    'cross_org_transfer_rejected',
    'decomiso_executed',
    'decomiso_handoff_accepted',
    'decomiso_handoff_cancelled',
    'decomiso_handoff_rejected',
    'decomiso_returned_to_owner',
    'dispute_escalated',
    'dispute_party_added',
    'dispute_raised',
    'dispute_resolved',
    'dispute_withdrawn',
    'dni_verified_self',
    'eno_backfill_run_completed',
    'eno_notification_emitted',
    'eno_notification_received',
    'eno_notification_reopened',
    'event_amended_sensitive',
    'evidence_viewed',
    'free_pet_claimed',
    'gob_dashboard_export_generated',
    'govt_assignment_unit_confirmed',
    'govt_assignment_unit_unconfirmed',
    'govt_business_rule_created',
    'govt_business_rule_deleted',
    'govt_business_rule_updated',
    'govt_deactivated_by_admin',
    'govt_locality_assigned',
    'govt_reactivated_by_admin',
    'govt_self_deactivated',
    'institutional_admin_created',
    'institutional_create_orphan_auth_user',
    'institutional_govt_created',
    'institutional_national_created',
    'jurisdiction_admin_appointed',
    'jurisdiction_admin_revoked',
    'mfa_factor_enrolled',
    'mfa_factors_reset_by_admin',
    'microchip.replace',
    'notification_fanout_empty',
    'operator_credentials_reset',
    'org_member_added',
    'org_member_event_write_changed',
    'org_member_removed',
    'org_member_role_changed',
    'org_unverified',
    'org_verified',
    'outbreak_investigation_closed_dismissed',
    'outbreak_investigation_closed_resolved',
    'outbreak_investigation_escalated',
    'outbreak_investigation_note_added',
    'outbreak_investigation_opened',
    'outreach_reminder_sent',
    'personal_self_deactivated',
    'personal_self_reactivated',
    'pet_events_mutation_override',
    'pet_transfer_accepted',
    'pet_transfer_cancelled',
    'pet_transfer_expired',
    'pet_transfer_initiated',
    'pet_transfer_rejected',
    'pii_queried',
    'ppp_export_generated',
    'profile_avatar_updated',
    'profile_avatar_upload_failed',
    'profile_self_updated',
    'rabies_observation_closed_professional',
    'request_approved',
    'request_info_requested',
    'request_rejected',
    'request_viewed',
    'revocation_admin_role',
    'revocation_govt_assignment',
    'revocation_govt_role',
    'revocation_org_verified',
    'revocation_scheduling',
    'revocation_vet_role',
    'scan_event_purged',
    'self_resignation_admin',
    'self_resignation_govt',
    'self_resignation_vet',
    'senasa_export_generated',
    'service_dog_credential_revoked',
    'sessions_revoked_self',
    'subject_data_exported',
    'subject_erasure',
    'tag.activate',
    'tag.lote_issue',
    'tag.revoke',
    'travel_export_generated',
    'welfare_location_viewed',
    'welfare_mpf_export_generated',
    'welfare_report_closed',
    'welfare_report_confirmed_spam',
    'welfare_report_derived_to_org',
    'welfare_report_escalated_to_admin',
    'welfare_report_started',
    'welfare_report_submitted_by_org',
    'welfare_report_triaged',
    'welfare_report_unflagged'
  ));

-- 5. govt_business_rules guard -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.govt_business_rule_place_codes(
  p_authority_unit_id uuid,
  p_locality_id uuid,
  p_jurisdiction_province text
)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT s.code ORDER BY s.code), ARRAY[]::text[])
    FROM (
      SELECT u.province_code AS code FROM public.authority_units u WHERE u.id = p_authority_unit_id
      UNION ALL
      SELECT l.province_code FROM public.ar_localities l WHERE l.id = p_locality_id
      UNION ALL
      SELECT public.ar_province_code(p_jurisdiction_province)
    ) s
   WHERE s.code IS NOT NULL
$$;

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
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.jurisdiction_admin_appointments a
       WHERE a.user_id = v_actor AND a.revoked_at IS NULL);
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

DROP TRIGGER IF EXISTS govt_business_rules_jurisdiction_admin_guard ON public.govt_business_rules;
CREATE TRIGGER govt_business_rules_jurisdiction_admin_guard
  BEFORE INSERT OR UPDATE ON public.govt_business_rules
  FOR EACH ROW EXECUTE FUNCTION public.govt_business_rules_jurisdiction_admin_guard();

-- 6. audit_log RLS: the jurisdiction admin of the row's province -------------------

CREATE OR REPLACE FUNCTION public.audit_row_visible_to_jurisdiction_admin(p_row public.audit_log)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(v.province_code = public.audit_row_province(p_row), false)
    FROM (SELECT public.jurisdiction_admin_province((SELECT auth.uid())) AS province_code) v
$$;

COMMENT ON FUNCTION public.audit_row_visible_to_jurisdiction_admin(public.audit_log) IS
  'True when the CALLER is a jurisdiction admin and the audit row belongs to their province (0269). Answers only for auth.uid().';

REVOKE EXECUTE ON FUNCTION public.audit_row_visible_to_jurisdiction_admin(public.audit_log)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_row_visible_to_jurisdiction_admin(public.audit_log)
  TO authenticated;

DROP POLICY IF EXISTS "audit log visible to the jurisdiction admin of its province"
  ON public.audit_log;
CREATE POLICY "audit log visible to the jurisdiction admin of its province"
  ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.jurisdiction_admin_province()) IS NOT NULL
    AND public.audit_row_visible_to_jurisdiction_admin(audit_log)
  );

-- 7. Post-condition ------------------------------------------------------------------

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.audit_log'::regclass AND conname = 'audit_log_action_valid';
  IF v_def IS NULL
     OR v_def NOT LIKE '%jurisdiction_admin_appointed%'
     OR v_def NOT LIKE '%jurisdiction_admin_revoked%'
     OR v_def NOT LIKE '%authority_unit_unconfirmed%'
     OR v_def NOT LIKE '%govt_assignment_unit_unconfirmed%'
     OR v_def NOT LIKE '%govt_reactivated_by_admin%'
     OR v_def NOT LIKE '%eno_notification_reopened%'
     OR v_def NOT LIKE '%case_escalated_manually%' THEN
    RAISE EXCEPTION 'Migration 0269 did not close: audit_log_action_valid does not admit the new actions, or the rewrite dropped an old one';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'audit_log' AND column_name = 'province_code'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.audit_log'::regclass
       AND conname = 'audit_log_province_code_valid' AND convalidated
  ) THEN
    RAISE EXCEPTION 'Migration 0269 did not close: audit_log.province_code or its validated CHECK is missing';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND (t.tgrelid, t.tgname) IN (
           ('public.audit_log'::regclass, 'audit_log_province_guard'),
           ('public.govt_business_rules'::regclass, 'govt_business_rules_jurisdiction_admin_guard')
         )) <> 2 THEN
    RAISE EXCEPTION 'Migration 0269 did not close: the audit or rules guard trigger is missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'audit_log_province_guard'
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
       AND p.prosrc LIKE '%jurisdiction_admin_province(NEW.actor_user_id)%'
       AND p.prosrc LIKE '%v_all_codes <> ARRAY[v_actor_province]%'
  ) THEN
    RAISE EXCEPTION 'Migration 0269 did not close: audit_log_province_guard must be SECURITY DEFINER, search_path '''', and compare every place against the actor''s province';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.audit_log'::regclass
       AND polname = 'audit log visible to the jurisdiction admin of its province'
       AND polcmd = 'r' AND polpermissive
       AND polroles = ARRAY['authenticated'::regrole::oid]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.audit_log'::regclass
       AND polname = 'institutional sessions require aal2' AND NOT polpermissive
  ) THEN
    RAISE EXCEPTION 'Migration 0269 did not close: the jurisdiction-admin audit SELECT branch is missing, or the aal2 restrictive policy is gone';
  END IF;

  IF has_function_privilege('anon', 'public.audit_row_visible_to_jurisdiction_admin(public.audit_log)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.audit_log_province_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0269 did not close: a SECURITY DEFINER function is anon-executable';
  END IF;
END
$$;
