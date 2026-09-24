-- Migration 0187 — an empty authority fan-out gets an audit action.
--
-- WHY
-- ---
-- Routing audit (2026-08-17, engram onboarding/ruteo-y-fallback): an empty
-- fan-out is the ONLY failure in this system that leaves no trace at all. The
-- recipients loop runs zero times, the server action returns `{ ok: true }`, and
-- nothing is written to notifications, to cron_runs, or to audit_log. A rabies
-- diagnosis, a bite report or a decomiso handoff can therefore reach NOBODY
-- while every surface reports success — which is exactly why it would be the
-- last failure anyone ever found.
--
-- 'notification_fanout_empty' is that trace. It is written best-effort by
-- findAuthoritiesForJurisdiction (lib/infra/approval-routing.ts) whenever the
-- resolver — govt-first, active-institutional-admin fallback — comes back with
-- zero user IDs, and by the handful of sites that assemble their own recipient
-- set outside the resolver.
--
-- It is NOT written when the admin fallback fires: that path did reach humans.
-- Only a genuinely empty set produces a row, so the working set stays small and
-- every row means "this notification went nowhere".
--
-- WHY audit_log AND NOT notification_dead_letter. The dead-letter table looks
-- like the natural home, but it is a RETRY QUEUE: the hourly drainer
-- (app/api/cron/drain-notification-dead-letter) replays every unresolved row
-- through createNotification(), and a synthetic row with no recipient fails
-- toInput() → counted `invalid` → the whole cron flips to failed and returns
-- HTTP 500. A durable trace must not manufacture an hourly false page.
-- audit_log is append-only, has a nullable actor (FK ON DELETE SET NULL,
-- migration 0080), is already the accountability spine, and nothing consumes it
-- as work.
--
-- IDEMPOTENCY: DROP IF EXISTS + unconditional ADD, so a replay converges on this
-- definition instead of silently no-opping on an environment that was
-- hand-patched (same reason migration 0185 re-ADDs rather than guarding).
--
-- ROLLBACK: re-run 0185's constraint body. No data is destroyed, but rows
--           already holding 'notification_fanout_empty' would violate the
--           narrowed CHECK — delete them first.

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
    'capability_denied',
    'capability_granted',
    'capability_revoked',
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
-- not contain what this migration exists to add. Assert the outcome.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
      AND  pg_get_constraintdef(c.oid) LIKE '%notification_fanout_empty%'
  ) THEN
    RAISE EXCEPTION
      'audit_log_action_valid does not accept notification_fanout_empty after migration 0187'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
