-- ────────────────────────────────────────────────────────────────────────────
-- 0287_alert_firing_and_outbox_retry_audit.sql
-- Two operator acts that left no actor in the audit register now leave one
-- (plan maestro A12, 2026-10-07).
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- The /admin/alertas triage (src/modules/alerts/application/firings/triage.ts)
-- recorded its transitions only in the firing's own *_at / *_by columns
-- (decision K-D4: "no new audit action"). Two of the six had no *_by column:
--   - "Registrar seguimiento" appended a note with no author at all;
--   - "Contactar autoridad" notified every govt user of a jurisdiction and
--     moved the firing to autoridad_contactada without recording WHO did it
--     (contacted_govt_user_id names the recipient, not the admin).
-- And none of the six was queryable alongside every other operator act.
-- K-D4 is superseded: every triage use case now writes one audit row, in the
-- transaction that changes the firing, with the acting admin as actor.
--
-- /admin/outbox "Reintentar" (app/admin/outbox/actions.ts) re-queues a
-- notification an authority may receive twice; it was baselined debt in
-- scripts/audit-log-coverage-baseline.json and is now covered.
--
-- THE AUDIT ACTIONS
-- ---------------------------------------------------------------------------
--   alert_firing_triaged         payload: firing_id, transition, from_status,
--                                to_status, metric_key, locality_id (when the
--                                firing names one — the province stamp reads
--                                it), plus per transition: note (seguimiento,
--                                cierre), investigation_code, recipients
--                                (count) and first_recipient_user_id.
--   outbox_row_retry_requested   payload: outbox_row_id, before_values.status,
--                                after_values.status / next_retry_at.
-- Postgres cannot add a value to a CHECK: it is dropped and rewritten whole,
-- as a SUPERSET of 0283's list, alphabetically.
-- `__tests__/audit-log-action-check.test.ts` compares it with
-- AUDIT_LOG_ACTIONS (db/schema.ts).
--
-- Numbered after 0284-0286, which origin/integration/security-lows claims.
-- No grant, no policy, no data change. Idempotent (DROP/ADD CONSTRAINT).
-- Forward-only. ROLLBACK (no deploy): re-run 0283's CHECK block — valid only
-- while no row carries either new action.
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
