-- ────────────────────────────────────────────────────────────────────────────
-- 0265_eno_notification_reopened_audit_action.sql
-- Re-opening a received ENO notice enters the audit register.
--
-- WHY (review of the health chain, PO decision 2026-09-26)
-- ---------------------------------------------------------------------------
-- A correction that makes a notice MORE urgent (PO S9) re-opens a record the
-- authority already marked "recibido" (0264): it goes back to pending with
-- its receipt cleared, because the authority has not seen what made it more
-- urgent. That is a change to a legal record someone else signed off, so it
-- is recorded: who corrected, which record, and whose receipt it replaced.
--
--   eno_notification_reopened   payload: outbox_row_id, reason,
--                               amendment_event_id, source_event_id,
--                               previous_received_at,
--                               previous_received_by_user_id,
--                               previous_delivered_at, sla_due_at
--
-- Postgres cannot add a value to a CHECK: it is dropped and rewritten whole,
-- from AUDIT_LOG_ACTIONS (db/schema.ts), alphabetically, the way 0264 did.
-- `__tests__/audit-log-action-check.test.ts` compares the two sets.
--
-- Idempotent. Forward-only. Rollback: a forward migration dropping the value
-- once no row carries it.
-- ────────────────────────────────────────────────────────────────────────────

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
    'govt_business_rule_created',
    'govt_business_rule_deleted',
    'govt_business_rule_updated',
    'govt_deactivated_by_admin',
    'govt_locality_assigned',
    'govt_self_deactivated',
    'institutional_admin_created',
    'institutional_create_orphan_auth_user',
    'institutional_govt_created',
    'institutional_national_created',
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_log_action_valid'
       AND pg_get_constraintdef(oid) LIKE '%eno_notification_reopened%'
  ) THEN
    RAISE EXCEPTION 'Migration 0265: audit_log_action_valid does not admit eno_notification_reopened';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_log_action_valid'
       AND pg_get_constraintdef(oid) LIKE '%eno_notification_received%'
  ) THEN
    RAISE EXCEPTION 'Migration 0265: the rewrite dropped eno_notification_received';
  END IF;
END
$$;
