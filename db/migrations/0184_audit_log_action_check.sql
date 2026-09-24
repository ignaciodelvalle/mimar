-- Migration 0184 — audit_log.action becomes a DB fact, not a TypeScript hope.
--
-- WHY
-- ---
-- `audit_log.action` is a bare `text` column. Its 102-value catalog lived ONLY
-- in TypeScript (`AUDIT_LOG_ACTIONS` in db/schema.ts, applied via drizzle's
-- `.$type<AuditLogAction>()`), which constrains exactly one writer class:
-- drizzle calls whose object literal is not cast. Everything else was free to
-- mint an action nobody had declared —
--
--   · DB triggers (db/triggers.sql: enforce_pet_events_append_only,
--     enforce_case_events_append_only) and RPCs (export_subject_data,
--     erase_subject_data) insert audit rows in plain SQL;
--   · `src/modules/transfers/actions.ts:72` inserts through a
--     `entry as typeof auditLog.$inferInsert` cast over an `action: string`;
--   · any future raw-SQL writer.
--
-- One had already escaped, for months, in production shape: the scan-retention
-- trigger (migration 0104) writes `scan_event_purged`, which was ABSENT from
-- AUDIT_LOG_ACTIONS — 160 such rows exist in the local database. A prior review
-- (docs/reviews/results/01-event-sourcing.md item 11) reported it as LOW next
-- to the two mutation_override actions; only those two were ever added, and
-- nothing could notice the omission because nothing compared the catalog to
-- what the table actually stored. That is the class this constraint closes: a
-- typo'd or undeclared action is now refused at write time instead of sitting
-- in the trail as an unqueryable, unfilterable, un-translated string.
--
-- The catalog stays the SAME single source of truth (db/schema.ts). This
-- constraint is its projection into the database, and
-- __tests__/audit-log-action-check.test.ts fails if the two ever drift, in
-- either direction.
--
-- WHY NOT `NOT VALID` -> `VALIDATE` (the pattern migrations 0156/0183 use)
-- ---------------------------------------------------------------------------
-- That pattern exists to avoid holding ACCESS EXCLUSIVE for the duration of the
-- validating scan: ADD CONSTRAINT ... NOT VALID takes the strong lock only
-- briefly, and a SEPARATE VALIDATE CONSTRAINT then scans under the much weaker
-- SHARE UPDATE EXCLUSIVE, so concurrent writes keep flowing.
--
-- It buys NOTHING here, and 0183 did not get this benefit either: scripts/
-- migrate.ts wraps each migration file in one BEGIN/COMMIT, so the ACCESS
-- EXCLUSIVE lock taken by ADD CONSTRAINT is held until the file's COMMIT no
-- matter what statement follows it. VALIDATE inside that same transaction runs
-- while the strong lock is still held — identical blocking to a plain
-- validating ADD, plus a second statement and the standing risk that someone
-- later adds a NOT VALID constraint and forgets the VALIDATE, leaving a
-- constraint that silently tolerates the very rows it claims to forbid.
--
-- So: a plain, immediately-validated CHECK. audit_log is append-only and this
-- is a text IN-list over a single column — the scan is a sequential read with
-- no lookups (117k rows locally: milliseconds). If a deployment target holds a
-- row this list does not know about, the PREFLIGHT below fails FIRST with the
-- offending values named, which is a far better outcome than a bare
-- "violates check constraint" or, worse, a NOT VALID constraint that lets the
-- bad rows stay and only pretends to guard.
--
-- IDEMPOTENCY: constraint add guarded by a pg_constraint lookup. Safe to
-- replay. The preflight is a no-op once the constraint exists.
--
-- ROLLBACK: ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_action_valid;
-- Nothing else in this migration writes data.

BEGIN;

-- 1. PREFLIGHT — name the offenders instead of failing anonymously ------------
-- Skipped when the constraint already exists (replay), because then no row can
-- violate it by construction.

DO $$
DECLARE
  unknown_actions text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
  ) THEN
    RETURN;
  END IF;

  SELECT string_agg(DISTINCT format('%s (%s rows)', action, n), ', ')
  INTO   unknown_actions
  FROM (
    SELECT action, count(*) AS n
    FROM   public.audit_log
    WHERE  action NOT IN (
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
    )
    GROUP BY action
  ) offenders;

  IF unknown_actions IS NOT NULL THEN
    RAISE EXCEPTION
      'audit_log holds action value(s) absent from AUDIT_LOG_ACTIONS: %. Add each to db/schema.ts AND to this migration''s list before applying (do NOT delete audit rows — the table is append-only).',
      unknown_actions
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 2. The CHECK — mirrors AUDIT_LOG_ACTIONS (db/schema.ts) exactly -------------
-- Kept in sync by __tests__/audit-log-action-check.test.ts, which reads this
-- constraint's definition out of pg_constraint and set-compares it with the
-- TypeScript catalog. Widen BOTH or the suite goes red.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'audit_log'
      AND  c.conname = 'audit_log_action_valid'
  ) THEN
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
  END IF;
END $$;

COMMIT;
