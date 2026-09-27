-- ────────────────────────────────────────────────────────────────────────────
-- 0272_jurisdiction_admin_trail_request_redaction.sql
-- The jurisdiction admin's audit trail stops handing out the approval request
-- of a row they did not act (jurisdiction-admin final review, LOW-2).
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- 0271 projected the payload and the two person columns of someone else's
-- row, and returned approval_request_id RAW. That id names one citizen's
-- application (a matrícula, an organisation's verification): it is the key
-- /gob/historial turned into the request's public token and a link, for every
-- row in the province — a third party's file reached through the audit trail,
-- which is exactly what the PO's M1 decision closed for the payload.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- approval_request_id is returned only on the caller's OWN rows; on anyone
-- else's it is NULL. The stricter of the two rules the review offered (own
-- rows only, rather than "rows whose actor is a funcionario"): a funcionario's
-- decision on a request is still visible as WHAT, WHO and WHEN, and a request
-- the appointee may decide is reachable from their own queue (/gob/cola),
-- whose scope check is the one that should answer — not the audit trail.
-- /gob/historial applies the same rule in auditHistoryRowColumns.
--
-- Only the function body changes: same signature, same return type, same
-- grants (re-asserted). CREATE OR REPLACE takes no lock on audit_log.
--
-- Idempotent. Forward-only. Ends in a post-condition that raises (0260).
-- ────────────────────────────────────────────────────────────────────────────

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
         CASE WHEN a.actor_user_id = v_caller THEN a.approval_request_id END,
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
  'The jurisdiction admin''s audit read (0271, 0272): rows of the caller''s province only, only while they are a live jurisdiction admin at aal2; someone else''s row is projected through audit_payload_redacted and audit_institutional_or_null (PO decision M1) and carries no approval_request_id (0272). Answers only for auth.uid().';

REVOKE EXECUTE ON FUNCTION public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)
  TO authenticated;

-- Post-condition ----------------------------------------------------------------------

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'jurisdiction_admin_audit_trail'
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""'];
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Migration 0272 did not close: jurisdiction_admin_audit_trail is not a definer function with a pinned search_path';
  END IF;
  -- The request id appears exactly once, and only inside the own-row CASE.
  IF v_src NOT LIKE '%CASE WHEN a.actor_user_id = v_caller THEN a.approval_request_id END%'
     OR array_length(regexp_split_to_array(v_src, 'a\.approval_request_id'), 1) <> 2 THEN
    RAISE EXCEPTION 'Migration 0272 did not close: the trail returns approval_request_id outside the caller''s own rows';
  END IF;
  -- 0271's projection survives the rewrite.
  IF v_src NOT LIKE '%audit_payload_redacted(a.action, a.payload)%'
     OR v_src NOT LIKE '%audit_institutional_or_null(a.actor_user_id)%'
     OR v_src NOT LIKE '%audit_institutional_or_null(a.target_user_id)%'
     OR v_src NOT LIKE '%caller_meets_institutional_aal()%' THEN
    RAISE EXCEPTION 'Migration 0272 did not close: the rewrite lost a 0271 projection or the aal2 check';
  END IF;
  IF has_function_privilege('anon',
       'public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.jurisdiction_admin_audit_trail(timestamptz, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0272 did not close: the trail carries the wrong grants';
  END IF;
END
$$;
