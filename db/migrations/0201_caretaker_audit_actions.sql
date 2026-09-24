-- Migration 0201 — the temporary-caretaker family gets its audit actions.
--
-- WHY
-- ---
-- src/modules/caretakers/actions.ts has written three audit actions since the
-- custodia-temporal feature shipped (migration 0189):
--   'caretaker_designated'      — the titular invites a caretaker
--   'caretaker_grant_accepted'  — the invitee accepts
--   'caretaker_grant_revoked'   — the titular ends the arrangement
--
-- None of the three was ever in AUDIT_LOG_ACTIONS, and therefore none was ever
-- in this CHECK. Every one of those inserts violated audit_log_action_valid
-- with a 23514, and the module's local `flushAuditLog` helper swallowed the
-- error behind a console.error that reads "(action did succeed)". It did — the
-- grant was written. The ACCOUNTABILITY ROW was not. Measured on staging: the
-- constraint allowed 105 actions, not one containing "caretaker", and audit_log
-- held ZERO rows for the whole feature — while the transfers module, which uses
-- a byte-identical helper, had all 9 of its actions allowed and 32 rows written.
--
-- WHY THE EXISTING FENCE DID NOT CATCH IT — and what now does.
-- __tests__/audit-log-action-check.test.ts set-compares THIS constraint against
-- the TypeScript catalog. Both sides agreed perfectly (105 = 105, zero
-- difference), so it was green throughout. It compares two DECLARATIONS against
-- each other and never compares either against the actual WRITERS. Its own
-- header names the hazard — the `as typeof auditLog.$inferInsert` cast that can
-- "mint an action nobody had declared" — and the caretakers module performs the
-- identical cast. scripts/check-audit-log-actions-declared.ts (pnpm
-- lint:audit-actions), added with this migration, closes that gap by deriving
-- the written literals from source and requiring each to be declared.
--
-- IDEMPOTENCY: DROP IF EXISTS + unconditional ADD, so a replay converges on this
-- definition instead of silently no-opping on an environment that was
-- hand-patched (same reason as 0185, 0187 and 0198).
--
-- VALIDATED, not NOT VALID: the ADD below carries no NOT VALID, so Postgres
-- validates against existing rows. That is asserted by the parity test — a
-- NOT VALID constraint tolerates the very rows it claims to forbid.
--
-- ROLLBACK: re-run 0198's constraint body. No data is destroyed, but rows
--           already holding a 'caretaker_*' action would violate the narrowed
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
    'caretaker_grant_revoked',
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
-- not contain what this migration exists to add. Assert the outcome, all three.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
      AND  pg_get_constraintdef(c.oid) LIKE '%caretaker_designated%'
      AND  pg_get_constraintdef(c.oid) LIKE '%caretaker_grant_accepted%'
      AND  pg_get_constraintdef(c.oid) LIKE '%caretaker_grant_revoked%'
      AND  c.convalidated
  ) THEN
    RAISE EXCEPTION
      'audit_log_action_valid does not accept the three caretaker actions (validated) after migration 0201'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
