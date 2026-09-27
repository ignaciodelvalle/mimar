-- ────────────────────────────────────────────────────────────────────────────
-- 0271_jurisdiction_admin_audit_redaction.sql
-- The jurisdiction administrator reads WHAT happened in their province and
-- WHEN — never the third-party personal data an audit payload carries (SDD
-- jurisdiction-admin, Phase 5; security review M1 of 0269, decided by the PO
-- on 2026-09-27).
--
-- THE DEFECT (M1)
-- ---------------------------------------------------------------------------
-- 0269 gave the jurisdiction admin a permissive SELECT branch on audit_log:
-- every row of their province, WHOLE. RLS filters rows, never columns, so
-- that branch handed a new principal the payload of every access trail in
-- the province — `pii_queried.query` (whatever a funcionario typed: a
-- citizen's name, a DNI), the DNI HMACs and e-mails other writers record, the
-- raw error text of a failed account creation. The PO's decision: the
-- appointee oversees misuse (who searched people, when, how often) and does
-- not need, and must not get, the people searched for. The platform admin
-- keeps full detail for investigations.
--
-- THE FIX
-- ---------------------------------------------------------------------------
--   1. The raw branch is DROPPED (and its helper with it). A jurisdiction
--      admin reads the table exactly like any govt again: their own rows.
--   2. public.audit_payload_redacted(action, payload) — the ONE redaction.
--      An explicit allow-list PER ACTION of the payload keys a reader outside
--      the actor may see, each type-checked; every other key, every other
--      action, and any key added to a writer tomorrow is dropped (fail-closed:
--      '{}' is the default). Today the allow-list is exactly what
--      /gob/historial renders for someone else's row: pii_queried's surface
--      and result count, and a business rule's type and named place.
--   3. public.audit_institutional_or_null(user) — a person on an audit row is
--      shown to the appointee only when they hold an institutional account (a
--      funcionario, whose acts are the point of the oversight); a citizen or
--      an organisation member reads as NULL.
--   4. public.jurisdiction_admin_audit_trail(...) — the appointee's read over
--      PostgREST: SECURITY DEFINER, answers only for auth.uid(), only while
--      they are a live jurisdiction admin, only at aal2 (the restrictive
--      policy of 0231 does not reach a definer function, so it is asked
--      here), only rows of their province (the stamp, else the single
--      province the row itself names — audit_place_province), and every row
--      projected through 2 and 3 unless the caller is its actor.
--      /gob/historial reads through Drizzle as the owner and uses the SAME
--      two functions (lib/infra/audit-history-query.ts).
--   5. The action CHECK rewritten whole (0269 pattern) to admit
--      `institutional_create_refused`: a delegated administrator's refused
--      account creation (a duplicate address among them) is audited, and the
--      administrator reads one generic sentence (Phase-4 review LOW-3).
--
--   6. public.audit_row_province(audit_log) is REPLACED by
--      public.audit_place_province(province_code, payload,
--      target_govt_assignment_id) — the same answer from scalar arguments,
--      so a Drizzle query (/gob/historial) and the trail call it on columns
--      instead of on a whole-row reference — and dropped: after 1 it has no
--      caller left. Owner-only, like the 0270 helpers.
--
-- A NOTE FOR WHOEVER TESTS THESE GRANTS (found while testing this file):
-- on the local Supabase image (PostgreSQL 17.6 + its preloaded extensions),
-- an `authenticated` session CALLING a STABLE or VOLATILE function it has no
-- EXECUTE on kills its backend with SIGSEGV instead of raising 42501, and the
-- postmaster restarts every connection — any other gate on the shared local
-- database goes down with it. IMMUTABLE functions deny cleanly (0270's test).
-- So the grants of 2, 3 and 1b are asserted from the catalog
-- (has_function_privilege), never by calling them as a denied role.
--
-- Idempotent. Forward-only. Ends in a post-condition that raises (0260).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. The raw read branch goes ------------------------------------------------------

DROP POLICY IF EXISTS "audit log visible to the jurisdiction admin of its province"
  ON public.audit_log;
DROP FUNCTION IF EXISTS public.audit_row_visible_to_jurisdiction_admin(public.audit_log);

-- 1b. The place of a row, from scalar arguments (see 6 above) ---------------------

CREATE OR REPLACE FUNCTION public.audit_place_province(
  p_province_code text,
  p_payload jsonb,
  p_target_govt_assignment_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    p_province_code,
    (SELECT CASE WHEN cardinality(c.codes) = 1 THEN c.codes[1] END
       FROM (SELECT public.audit_row_place_codes(p_payload, p_target_govt_assignment_id)
                    AS codes) c))
$$;

COMMENT ON FUNCTION public.audit_place_province(text, jsonb, uuid) IS
  'The province an audit row belongs to: its stamp, else the single province the row itself names; ambiguous or unplaced rows are NULL — visible to the platform admin only (0269 semantics; scalar arguments since 0271). No SET search_path on purpose (it runs per row of a history scan); every name is schema-qualified. Owner-only.';

REVOKE EXECUTE ON FUNCTION public.audit_place_province(text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.audit_row_province(public.audit_log);

-- 2. The redaction -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.audit_payload_redacted(p_action text, p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN '{}'::jsonb
    -- An access trail: which screen, how many results. Never the query, the
    -- filters, the zone or anything else the writer recorded.
    WHEN p_action = 'pii_queried' THEN jsonb_strip_nulls(jsonb_build_object(
      'surface',
        CASE WHEN jsonb_typeof(p_payload -> 'surface') = 'string' THEN p_payload -> 'surface' END,
      'result_count',
        CASE WHEN jsonb_typeof(p_payload -> 'result_count') = 'number'
             THEN p_payload -> 'result_count' END))
    -- A business rule: its type and the place it applies to (names of a
    -- country, a province, a locality). Never the rule's payload or reason.
    WHEN p_action IN ('govt_business_rule_created', 'govt_business_rule_updated',
                      'govt_business_rule_deleted') THEN jsonb_strip_nulls(jsonb_build_object(
      'ruleType',
        CASE WHEN jsonb_typeof(p_payload -> 'ruleType') = 'string' THEN p_payload -> 'ruleType' END,
      'jurisdiction',
        CASE WHEN jsonb_typeof(p_payload -> 'jurisdiction') = 'object' THEN jsonb_build_object(
          'country',
            CASE WHEN jsonb_typeof(p_payload -> 'jurisdiction' -> 'country') = 'string'
                 THEN p_payload -> 'jurisdiction' -> 'country' END,
          'province',
            CASE WHEN jsonb_typeof(p_payload -> 'jurisdiction' -> 'province') = 'string'
                 THEN p_payload -> 'jurisdiction' -> 'province' END,
          'locality',
            CASE WHEN jsonb_typeof(p_payload -> 'jurisdiction' -> 'locality') = 'string'
                 THEN p_payload -> 'jurisdiction' -> 'locality' END) END))
    -- Every other action — every other access trail (welfare_location_viewed,
    -- evidence_viewed, adopter_pii_viewed, the exports) included — is WHAT
    -- and WHEN only.
    ELSE '{}'::jsonb
  END
$$;

COMMENT ON FUNCTION public.audit_payload_redacted(text, jsonb) IS
  'The audit payload a reader other than the row''s actor may see (0271, PO decision M1): an explicit, type-checked allow-list per action; everything else is dropped. Owner-only: called by jurisdiction_admin_audit_trail and by /gob/historial as the owner.';

REVOKE EXECUTE ON FUNCTION public.audit_payload_redacted(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_institutional_or_null(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p.id FROM public.profiles p
   WHERE p.id = p_user AND p.account_type = 'institutional'
$$;

COMMENT ON FUNCTION public.audit_institutional_or_null(uuid) IS
  'The user id when it names an institutional account, else NULL (0271): a person on an audit row is shown to a jurisdiction admin only when they are a funcionario. Owner-only.';

REVOKE EXECUTE ON FUNCTION public.audit_institutional_or_null(uuid) FROM PUBLIC, anon, authenticated;

-- 3. The appointee's read -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_audit_trail(
  p_before_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  performed_at timestamptz,
  action text,
  actor_user_id uuid,
  target_user_id uuid,
  approval_request_id uuid,
  province_code text,
  payload jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_province text;
BEGIN
  -- A definer function is not reached by the restrictive aal2 policy (0231):
  -- ask it here, first.
  IF v_caller IS NULL OR NOT public.caller_meets_institutional_aal() THEN
    RETURN;
  END IF;
  v_province := public.jurisdiction_admin_province(v_caller);
  IF v_province IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id,
         a.performed_at,
         a.action,
         CASE WHEN a.actor_user_id = v_caller THEN a.actor_user_id
              ELSE public.audit_institutional_or_null(a.actor_user_id) END,
         CASE WHEN a.actor_user_id = v_caller THEN a.target_user_id
              ELSE public.audit_institutional_or_null(a.target_user_id) END,
         a.approval_request_id,
         v_province,
         CASE WHEN a.actor_user_id = v_caller THEN a.payload
              ELSE public.audit_payload_redacted(a.action, a.payload) END
    FROM public.audit_log a
   WHERE (a.province_code = v_province
          OR (a.province_code IS NULL
              AND public.audit_place_province(NULL, a.payload, a.target_govt_assignment_id)
                  = v_province))
     AND (p_before_at IS NULL
          OR a.performed_at < p_before_at
          OR (p_before_id IS NOT NULL AND a.performed_at = p_before_at AND a.id < p_before_id))
   ORDER BY a.performed_at DESC, a.id DESC
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;

COMMENT ON FUNCTION public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer) IS
  'The jurisdiction admin''s audit read (0271): rows of the caller''s province only, only while they are a live jurisdiction admin at aal2; someone else''s row is projected through audit_payload_redacted and audit_institutional_or_null (PO decision M1). Answers only for auth.uid().';

REVOKE EXECUTE ON FUNCTION public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)
  TO authenticated;

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
    'institutional_create_refused',
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

-- 5. Post-condition ------------------------------------------------------------------

DO $$
DECLARE
  v_def text;
BEGIN
  -- M1: audit_log's permissive SELECT policies are exactly the actor/admin
  -- one. Any other branch — the 0269 one or a new one — would hand some
  -- principal whole payloads again.
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.audit_log'::regclass
       AND polpermissive
       AND polname <> 'audit log visible to actor or admin'
  ) THEN
    RAISE EXCEPTION 'Migration 0271 did not close: audit_log has a permissive policy other than "audit log visible to actor or admin"';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.audit_log'::regclass
       AND polname = 'institutional sessions require aal2' AND NOT polpermissive
  ) THEN
    RAISE EXCEPTION 'Migration 0271 did not close: the aal2 restrictive policy on audit_log is gone';
  END IF;
  IF to_regprocedure('public.audit_row_visible_to_jurisdiction_admin(public.audit_log)') IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0271 did not close: the 0269 read-branch helper still exists';
  END IF;
  IF to_regprocedure('public.audit_row_province(public.audit_log)') IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0271 did not close: audit_row_province(audit_log) still exists';
  END IF;
  IF has_function_privilege('anon', 'public.audit_place_province(text, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.audit_place_province(text, jsonb, uuid)', 'EXECUTE')
     OR public.audit_place_province('AR-M', '{}'::jsonb, NULL) IS DISTINCT FROM 'AR-M'
     OR public.audit_place_province(NULL, '{}'::jsonb, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0271 did not close: audit_place_province has the wrong grants or answer';
  END IF;

  -- The redaction drops what it must.
  IF public.audit_payload_redacted('pii_queried',
       '{"query":"Juan Perez","surface":"x","result_count":2,"dni_hmac":"h"}'::jsonb)
       IS DISTINCT FROM '{"surface":"x","result_count":2}'::jsonb
     OR public.audit_payload_redacted('welfare_location_viewed',
       '{"welfare_report_id":"r","reference_code":"c"}'::jsonb) IS DISTINCT FROM '{}'::jsonb
     OR public.audit_payload_redacted('institutional_create_orphan_auth_user',
       '{"intended_email":"a@b.c","tx_error":"x"}'::jsonb) IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'Migration 0271 did not close: audit_payload_redacted does not redact';
  END IF;

  -- The trail is a definer function with a pinned search_path, for
  -- authenticated only; the two helpers are owner-only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'jurisdiction_admin_audit_trail'
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
       AND p.prosrc LIKE '%audit_payload_redacted(a.action, a.payload)%'
       AND p.prosrc LIKE '%caller_meets_institutional_aal()%'
  ) OR has_function_privilege('anon',
         'public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
         'public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.audit_payload_redacted(text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.audit_payload_redacted(text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.audit_institutional_or_null(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.audit_institutional_or_null(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Migration 0271 did not close: the trail or its helpers carry the wrong shape or grants';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.audit_log'::regclass AND conname = 'audit_log_action_valid';
  IF v_def IS NULL
     OR v_def NOT LIKE '%institutional_create_refused%'
     OR v_def NOT LIKE '%jurisdiction_admin_appointed%'
     OR v_def NOT LIKE '%welfare_report_unflagged%'
     OR v_def NOT LIKE '%admin_deactivated_by_admin%' THEN
    RAISE EXCEPTION 'Migration 0271 did not close: audit_log_action_valid does not admit institutional_create_refused, or the rewrite dropped an old action';
  END IF;
END
$$;
