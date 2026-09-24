-- Migration 0221 — a personal account can switch itself back ON.
--
-- WHY
-- ---
-- requireLiveUser now refuses writes for a deactivated PERSONAL account, not
-- only an institutional one. Before that change the /cuenta "Desactivar mi
-- cuenta" dialog promised an irreversible act and delivered nothing: the column
-- was written and no write boundary read it. Enforcing it closes the lie and
-- opens a dead end — every write refused, with support as the only route back
-- from a decision the person made about their own account.
--
-- selfReactivatePersonalAccountForUser is that route back, and every account
-- state change in this system leaves a trail. This migration declares the action
-- that writer records.
--
-- WHY A NEW ACTION AND NOT A REUSE
-- ---------------------------------------------------------------------------
-- It is not personal_self_deactivated with an inverted payload: the trail's
-- job is to answer "what happened to this account, and when", and an action
-- whose meaning flips on a payload field cannot be asked that question through
-- buildAuditActionOptions() (lib/ui/audit-action-labels.ts), which builds the
-- /admin/auditoria filter by iterating the label map. An auditor must be able to
-- ask for reactivations specifically.
--
-- It is not profile_self_updated either. That action covers edits to the
-- person's own descriptive fields; this one changes whether the account may act
-- at all, which is the distinction the constraint catalog exists to preserve.
--
-- The repo's own rule for when an act earns its own action (0202 SPLIT on a
-- differing ACTOR; 0203 KEPT one action when only the TRANSPORT differed) puts
-- this squarely on the split side: the act differs, not its transport.
--
-- INSTITUTIONAL REACTIVATION IS NOT THIS ACTION AND DELIBERATELY HAS NONE HERE.
-- Switching an institutional account back on is an operator's act on somebody
-- else's account and does not go through this path at all; the use-case refuses
-- a non-personal accountType in the database, not in the UI.
--
-- PAYLOAD: { role }. No motivo, and the asymmetry with
-- personal_self_deactivated is intentional — the deactivation demands a
-- written reason because it takes something away, and charging a person prose
-- to undo their own decision is friction billed in the safe direction.
--
-- IDEMPOTENCY: DROP IF EXISTS + unconditional ADD, so a replay converges on this
-- definition instead of silently no-opping on an environment that was hand
-- patched (same reason as 0185, 0187, 0198, 0201, 0202, 0203 and 0220).
--
-- VALIDATED, not NOT VALID: the ADD below carries no NOT VALID, so Postgres
-- validates against existing rows. A NOT VALID constraint tolerates the very
-- rows it claims to forbid.
--
-- ROLLBACK: re-run 0220's constraint body. No data is destroyed, but rows
--           already holding 'personal_self_reactivated' would violate the
--           narrowed CHECK — delete them first.

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
      AND  pg_get_constraintdef(c.oid) LIKE '%personal_self_reactivated%'
      AND  c.convalidated
  ) THEN
    RAISE EXCEPTION
      'audit_log_action_valid does not accept personal_self_reactivated (validated) after migration 0221'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
