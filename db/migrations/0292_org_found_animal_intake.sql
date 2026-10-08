-- ────────────────────────────────────────────────────────────────────────────
-- 0292_org_found_animal_intake.sql
-- An organization can say "Recibimos animales encontrados": the plan-B list a
-- finder sees when they cannot keep an animal until its family appears.
-- OFF by default. Every change is audited. Design note:
-- docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md.
--
-- WHY A TABLE AND NOT COLUMNS ON organizations
-- ---------------------------------------------------------------------------
-- organizations is closed to every caller role's write through PostgREST and
-- carries a dozen consents of its own. This setting has a different writer
-- (the org's ADMINS, with an RLS write path as the backstop), a different
-- audience (an anonymous finder, through one server read) and its own audit.
-- One row per organization, keyed by it.
--
-- WHAT A ROW SAYS
-- ---------------------------------------------------------------------------
--   accepting             the switch; false = not listed, whatever else is set
--   capacity_status       recibimos | consultar | sin_lugar
--   public_contact_kind   telefono | whatsapp | email | web  ┐ both or neither:
--   public_contact_value  the channel as the org typed it   ┘ the org CHOOSES
--                         to publish it; never copied from organizations.email
--                         or .phone, which were given to miMAR, not to the public
--   public_hours          optional free text
-- No person column: who changed what lives in audit_log.
--
-- WHO IS LISTED — decided in the query, not here
-- ---------------------------------------------------------------------------
-- accepting AND organizations.verified AND status = 'active' AND org_type in
-- (shelter, rescue_network, clinic, sanitary_authority):
-- src/modules/organizations/infrastructure/found-animal-help-read.ts. The type
-- rule's pure twin is src/modules/organizations/domain/found-animal-intake.ts.
--
-- RLS
-- ---------------------------------------------------------------------------
-- anon: no privilege, no policy. The public reads through one server-side
-- Drizzle read (BYPASSRLS) that projects public-safe fields only.
-- authenticated: SELECT for an active MEMBER of the org; INSERT and UPDATE for
-- an active ADMIN of the org; no DELETE (turning it off is accepting = false).
-- The admin test goes through public.caller_is_active_org_admin, SECURITY
-- DEFINER, for the reason 0273 gives for caller_is_active_org_member: a policy
-- subquery on organization_memberships recurses through that table's peers
-- policy.
--
-- THE AUDIT IS A TRIGGER, ON PURPOSE
-- ---------------------------------------------------------------------------
-- An app-side audit row covers the app's write and nothing else; the RLS write
-- path above would be an unaudited door. So the database writes the row:
-- org_found_animal_intake_changed, payload { org_id, before_values,
-- after_values }, on INSERT and on any UPDATE that changes a governed column.
-- The actor is auth.uid() (a PostgREST write) or the transaction-local
-- app.actor_user_id the server action sets. A write with NEITHER is refused:
-- an audit row with no actor is not accountability.
-- AUDIT_LOG_ACTIONS (db/schema.ts) gains the action; the CHECK is rewritten
-- whole from it, alphabetically, the way 0283 and 0287 did.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS). Forward-only.
-- ROLLBACK (no deploy): UPDATE public.org_found_animal_intake SET accepting =
-- false — every org leaves the finder's list at once.
-- ────────────────────────────────────────────────────────────────────────────

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_found_animal_intake (
  organization_id       uuid        PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  accepting             boolean     NOT NULL DEFAULT false,
  capacity_status       text        NOT NULL DEFAULT 'recibimos',
  public_contact_kind   text,
  public_contact_value  text,
  public_hours          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_found_animal_intake_capacity_valid
    CHECK (capacity_status IN ('recibimos', 'consultar', 'sin_lugar')),
  CONSTRAINT org_found_animal_intake_contact_kind_valid
    CHECK (public_contact_kind IS NULL OR public_contact_kind IN ('telefono', 'whatsapp', 'email', 'web')),
  CONSTRAINT org_found_animal_intake_contact_pair
    CHECK ((public_contact_kind IS NULL) = (public_contact_value IS NULL)),
  CONSTRAINT org_found_animal_intake_contact_length
    CHECK (public_contact_value IS NULL OR length(public_contact_value) BETWEEN 3 AND 200),
  CONSTRAINT org_found_animal_intake_hours_length
    CHECK (public_hours IS NULL OR length(public_hours) <= 120)
);

COMMENT ON TABLE public.org_found_animal_intake IS
  'Whether an organization receives found animals (the finder''s plan-B list), its capacity status and the contact it chose to publish. Off by default; listed only while the org is verified and active. Every change audited by trigger (migration 0292).';

-- The public read filters on the switch first.
CREATE INDEX IF NOT EXISTS org_found_animal_intake_accepting_idx
  ON public.org_found_animal_intake (organization_id)
  WHERE accepting;

-- ---------------------------------------------------------------------------
-- 2. The admin helper
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.caller_is_active_org_admin(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id
       AND m.user_id = auth.uid()
       AND m.role = 'admin'
       AND m.left_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.caller_is_active_org_admin(uuid) IS
  'True when auth.uid() holds an active ADMIN membership (left_at IS NULL) in the organization. Answers only about the caller. SECURITY DEFINER for the recursion reason 0273 gives (migration 0292).';

REVOKE EXECUTE ON FUNCTION public.caller_is_active_org_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_is_active_org_admin(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.org_found_animal_intake ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.org_found_animal_intake FROM PUBLIC, anon;
REVOKE ALL ON public.org_found_animal_intake FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.org_found_animal_intake TO authenticated;

DROP POLICY IF EXISTS "found animal intake read by org member" ON public.org_found_animal_intake;
CREATE POLICY "found animal intake read by org member"
  ON public.org_found_animal_intake
  FOR SELECT
  TO authenticated
  USING (public.caller_is_active_org_member(organization_id));

DROP POLICY IF EXISTS "found animal intake inserted by org admin" ON public.org_found_animal_intake;
CREATE POLICY "found animal intake inserted by org admin"
  ON public.org_found_animal_intake
  FOR INSERT
  TO authenticated
  WITH CHECK (public.caller_is_active_org_admin(organization_id));

DROP POLICY IF EXISTS "found animal intake updated by org admin" ON public.org_found_animal_intake;
CREATE POLICY "found animal intake updated by org admin"
  ON public.org_found_animal_intake
  FOR UPDATE
  TO authenticated
  USING (public.caller_is_active_org_admin(organization_id))
  WITH CHECK (public.caller_is_active_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- 4. Stamps: the row's org never moves; timestamps are the database's
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_found_animal_intake_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'org_found_animal_intake.organization_id is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS org_found_animal_intake_stamp ON public.org_found_animal_intake;
CREATE TRIGGER org_found_animal_intake_stamp
  BEFORE INSERT OR UPDATE ON public.org_found_animal_intake
  FOR EACH ROW EXECUTE FUNCTION public.org_found_animal_intake_stamp();

-- ---------------------------------------------------------------------------
-- 5. The audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_found_animal_intake_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_before jsonb := NULL;
  v_after  jsonb;
  v_actor  uuid;
  v_raw    text;
BEGIN
  v_after := jsonb_build_object(
    'accepting', NEW.accepting,
    'capacity_status', NEW.capacity_status,
    'public_contact_kind', NEW.public_contact_kind,
    'public_contact_value', NEW.public_contact_value,
    'public_hours', NEW.public_hours
  );
  IF TG_OP = 'UPDATE' THEN
    v_before := jsonb_build_object(
      'accepting', OLD.accepting,
      'capacity_status', OLD.capacity_status,
      'public_contact_kind', OLD.public_contact_kind,
      'public_contact_value', OLD.public_contact_value,
      'public_hours', OLD.public_hours
    );
    -- A re-save with nothing changed is not a change.
    IF v_before = v_after THEN
      RETURN NULL;
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    v_raw := NULLIF(current_setting('app.actor_user_id', true), '');
    IF v_raw IS NOT NULL THEN
      v_actor := v_raw::uuid;
    END IF;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'org_found_animal_intake: a change needs an accountable actor (auth.uid() or app.actor_user_id)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_log (actor_user_id, action, target_organization_id, payload)
  VALUES (
    v_actor,
    'org_found_animal_intake_changed',
    NEW.organization_id,
    jsonb_build_object(
      'org_id', NEW.organization_id,
      'before_values', v_before,
      'after_values', v_after
    )
  );
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.org_found_animal_intake_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS org_found_animal_intake_audit ON public.org_found_animal_intake;
CREATE TRIGGER org_found_animal_intake_audit
  AFTER INSERT OR UPDATE ON public.org_found_animal_intake
  FOR EACH ROW EXECUTE FUNCTION public.org_found_animal_intake_audit();

-- ---------------------------------------------------------------------------
-- 6. The audit action
-- ---------------------------------------------------------------------------

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
    'alert_firing_triaged',
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
    'org_found_animal_intake_changed',
    'org_member_added',
    'org_member_event_write_changed',
    'org_member_removed',
    'org_member_role_changed',
    'org_public_directory_opt_in_changed',
    'org_unverified',
    'org_verified',
    'outbox_row_retry_requested',
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

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.org_found_animal_intake'::regclass) THEN
    RAISE EXCEPTION 'Migration 0292 did not close: RLS is not enabled on org_found_animal_intake';
  END IF;
  IF has_table_privilege('anon', 'public.org_found_animal_intake', 'SELECT')
     OR has_table_privilege('anon', 'public.org_found_animal_intake', 'INSERT')
     OR has_table_privilege('anon', 'public.org_found_animal_intake', 'UPDATE')
     OR has_table_privilege('anon', 'public.org_found_animal_intake', 'DELETE') THEN
    RAISE EXCEPTION 'Migration 0292 did not close: anon holds a privilege on org_found_animal_intake';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'org_found_animal_intake'
                AND (cmd = 'DELETE' OR cmd = 'ALL' OR NOT (roles = ARRAY['authenticated']::name[]))) THEN
    RAISE EXCEPTION 'Migration 0292 did not close: a policy on org_found_animal_intake admits DELETE or a role other than authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.caller_is_active_org_admin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.caller_is_active_org_admin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0292 did not close: caller_is_active_org_admin carries the wrong grants';
  END IF;
END
$$;
