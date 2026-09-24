-- Migration 0203 — B11 declares `sessions_revoked_self`.
--
-- WHY
-- ---
-- "Cerrar sesión en todos los dispositivos" (B11) is the counterpart that makes
-- B9's long citizen session defensible: a 30-day session is only acceptable if
-- the holder can end it from somewhere else. The use-case
-- (src/modules/auth/application/revoke-sessions.ts) writes one audit row per
-- revocation, so the action needs declaring in both catalogs.
--
-- WHY THIS ONE IS AUDITED WHEN PLAIN LOGOUT IS NOT
-- Ordinary logout writes no row, and should not: ending your own session on your
-- own device is navigation. This is a security RESPONSE — people press it
-- because a phone was lost, a machine was shared, or they suspect someone got
-- in. "When did the legitimate owner last cut every session?" is exactly what an
-- incident review asks, and it is unanswerable afterwards unless it was recorded
-- as it happened. It belongs to the same self-service family already in the
-- catalog: 'personal_self_deactivated', 'govt_self_deactivated',
-- 'dni_verified_self'.
--
-- No privacy cost: actor, target and subject are one person, and the row carries
-- nothing beyond the actor FK every row already carries. Payload is
-- { surface: 'web' | 'api_v1' } — which door was used, never where from.
--
-- ONE ACTION, NOT ONE PER SURFACE. The web button and POST /api/v1/me/revoke-
-- sessions perform the identical act with the identical authority; only the
-- transport differs, and a payload discriminator is the right weight for that.
-- Contrast 0202, which split three grant endings into three actions because the
-- ACTOR differed — here it does not.
--
-- IDEMPOTENCY: DROP IF EXISTS + unconditional ADD, so a replay converges on this
-- definition instead of silently no-opping on an environment that was
-- hand-patched (same reason as 0185, 0187, 0198, 0201 and 0202).
--
-- VALIDATED, not NOT VALID: the ADD below carries no NOT VALID, so Postgres
-- validates against existing rows. That is asserted by the parity test — a
-- NOT VALID constraint tolerates the very rows it claims to forbid.
--
-- ROLLBACK: re-run 0202's constraint body. No data is destroyed, but rows
--           already holding 'sessions_revoked_self' would violate the narrowed
--           CHECK — delete them first.

-- audit_log.action -------------------------------------------------------------
-- Mirrors AUDIT_LOG_ACTIONS (db/schema.ts) exactly; kept in sync by
-- __tests__/audit-log-action-check.test.ts, which set-compares this constraint's
-- definition against the TypeScript catalog. Widen BOTH or the suite goes red.

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
    'case_events_mutation_override',
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
    'event_amended_sensitive',
    'evidence_viewed',
    'free_pet_claimed',
    'gob_dashboard_export_generated',
    'govt_business_rule_created',
    'govt_business_rule_deleted',
    'govt_business_rule_updated',
    'govt_deactivated_by_admin',
    'govt_locality_assigned',
    'govt_self_deactivated',
    'institutional_admin_created',
    'institutional_create_orphan_auth_user',
    'institutional_govt_created',
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

-- Fence — "applied" is not "closed" -------------------------------------------
-- A DROP/ADD pair reports success even when it landed on a definition that does
-- not contain what this migration exists to add. Assert the outcome, and that
-- the constraint is VALIDATED rather than merely present.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
      AND  pg_get_constraintdef(c.oid) LIKE '%sessions_revoked_self%'
      AND  c.convalidated
  ) THEN
    RAISE EXCEPTION
      'audit_log_action_valid does not accept sessions_revoked_self (validated) after migration 0203'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
