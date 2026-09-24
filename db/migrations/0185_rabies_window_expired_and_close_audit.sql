-- Migration 0185 — the rabies observation gets a state for "nobody closed it",
-- and the professional closure gets an audit action.
--
-- WHY
-- ---
-- Until 2026-08-17 two paths wrote `rabies_observation_ended` with
-- outcome='negative' and no clinical author:
--
--   · the daily sweep (closed_by_role='system', recorded_by_user_id NULL,
--     author_verified FALSE, note "Auto-cerrado tras 10 dias sin sintomas
--     escalables"), and
--   · the OWNER of the animal that bit somebody, gated only on the window
--     having elapsed and on that same owner not having self-reported a symptom.
--
-- If a person exposed to that animal later develops rabies, that row is the
-- State's own document asserting the animal was clear. The PO decided (engram
-- roadmap/decisiones-legales-flujos-2026-08-17, item 1) that only a professional
-- may assert a clinical outcome. Both writers are gone.
--
-- Removing them without a landing state would strand every observation open
-- forever: the credential's public banner never clears and the owner has no
-- remedy. So `pets.rabies_observation_status` gains ONE value:
--
--   'window_expired_unclosed' — the statutory window elapsed and nobody with a
--   clinical mandate closed it. Asserts NOTHING in either direction. Not
--   terminal: a professional close still moves it to a completed_* value, and
--   the bite expediente stays open as work for the sanitary authority.
--
-- No new event type: the state is the passage of time over facts the spine
-- already holds (rabies_observation_started.observation_until + the absence of a
-- rabies_observation_ended). Minting an event would mean inventing an author for
-- a non-act, which is the exact lie this change deletes.
--
-- The same close is now the ONLY way an outcome enters the record, performed by
-- an identified operator, so it also gains an audit action:
-- 'rabies_observation_closed_professional'.
--
-- IDEMPOTENCY: both constraints are DROP IF EXISTS + ADD, so a replay converges
-- on the same definition instead of silently no-opping on an environment that
-- was hand-patched (migration 0184 guards its ADD with a pg_constraint lookup,
-- which is exactly why widening its list needs an unconditional re-ADD here).
-- The fences at the end fail loudly if either constraint did not end up
-- accepting the new value.
--
-- ROLLBACK: re-run 0184's constraint body and restore the 5-value pets list.
--           No data is destroyed; rows already holding the new status would
--           then violate the narrowed CHECK, so drain them first.

-- 1. pets.rabies_observation_status --------------------------------------------

ALTER TABLE public.pets
  DROP CONSTRAINT IF EXISTS pets_rabies_observation_status_valid;

ALTER TABLE public.pets
  ADD CONSTRAINT pets_rabies_observation_status_valid
  CHECK (
    rabies_observation_status IS NULL
    OR rabies_observation_status IN (
      'in_progress',
      'window_expired_unclosed',
      'completed_negative',
      'completed_positive_rabies',
      'completed_dead',
      'completed_lost_to_followup'
    )
  );

-- 2. audit_log.action ----------------------------------------------------------
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

-- 3. Fences — "applied" is not "closed" ---------------------------------------
-- A DROP/ADD pair reports success even when it landed on a definition that does
-- not contain what this migration exists to add. Assert the outcome, not the
-- statement.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'pets'
      AND  c.conname = 'pets_rabies_observation_status_valid'
      AND  pg_get_constraintdef(c.oid) LIKE '%window_expired_unclosed%'
  ) THEN
    RAISE EXCEPTION
      'pets_rabies_observation_status_valid does not accept window_expired_unclosed after migration 0185'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
      AND  pg_get_constraintdef(c.oid) LIKE '%rabies_observation_closed_professional%'
  ) THEN
    RAISE EXCEPTION
      'audit_log_action_valid does not accept rabies_observation_closed_professional after migration 0185'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
