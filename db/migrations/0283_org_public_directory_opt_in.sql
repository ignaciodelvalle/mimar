-- ────────────────────────────────────────────────────────────────────────────
-- 0283_org_public_directory_opt_in.sql
-- A verified veterinary clinic can choose to appear in the public directory
-- at /refugios ("Refugios y veterinarias"). OFF by default. Switching it is
-- recorded in the audit register.
--
-- WHY (PO decision 2026-10-02)
-- ---------------------------------------------------------------------------
-- The directory listed only verified shelters and rescue networks. The landing
-- now links it as "Refugios y vets cerca", so verified clinics may be listed
-- too — but ONLY the ones that ask for it from their organization settings.
-- A clinic is a business that signed up to keep clinical records, not to be
-- advertised; publishing its name and contact is its own decision.
--
-- WHY A NEW COLUMN AND NOT AN EXISTING SETTING
-- ---------------------------------------------------------------------------
-- None of the existing public-visibility flags means "list me":
--   - tier_0_show_branding / tier_0_show_origin_org name the org on a PET's
--     public credential (event authorship, origin shelter);
--   - disclose_address gates the map pin on the org's public profile.
-- Reusing either would couple two consents the org gives separately.
--
-- WHO THE FLAG GOVERNS
-- ---------------------------------------------------------------------------
-- Clinics only. Shelters and rescue networks stay listed on verification
-- alone, exactly as before: their adoption listings at /adoptar already link
-- to their public profile, so an opt-out would hide a row in one list while
-- the profile stays one click away from every pet they publish. For them the
-- column stays false and is not read. The single predicate is
-- lib/infra/org-directory.ts → publicDirectoryVisible() (verified, active,
-- and a rehoming org or an opted-in clinic).
--
-- WHAT A LISTED CLINIC SHOWS — decided in code, not here
-- ---------------------------------------------------------------------------
-- lib/infra/org-public-profile.ts withholds a clinic's legal name (for a solo
-- vet it is the vet's own name) and its coordinates: disclose_address
-- defaults to true and no form lets a clinic set it, so a true there is a
-- default, not a choice. Changing that default here would also move
-- shelters, whose pin the column already governs; the code rule touches
-- clinics only.
--
-- THE AUDIT ACTION
-- ---------------------------------------------------------------------------
--   org_public_directory_opt_in_changed   payload: org_id,
--                                         before_values.public_directory_opt_in,
--                                         after_values.public_directory_opt_in
-- Written by src/modules/organizations/application/update-organization.ts in
-- the transaction that writes the column, only when the value changes.
-- Postgres cannot add a value to a CHECK: it is dropped and rewritten whole,
-- from AUDIT_LOG_ACTIONS (db/schema.ts), alphabetically, the way 0265 did.
-- `__tests__/audit-log-action-check.test.ts` compares the two sets.
--
-- NO ANONYMOUS READ
-- ---------------------------------------------------------------------------
-- 0278-0280 closed every anon read of organizations: no row policy admits
-- anon, whatever deploy-provision re-grants. This migration adds no grant, no
-- policy, no view and no function. The directory and the profile read
-- through Drizzle (BYPASSRLS) on the server, projecting only the listed orgs'
-- public fields; PostgREST with the publishable key still reads zero
-- organizations. Fence: __tests__/org-public-directory.test.ts ("anon
-- surface") and check 6 of scripts/check-rls-coverage.ts.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, DROP/ADD CONSTRAINT). Forward-only.
-- No backfill: every existing clinic starts unlisted, which is the point.
-- ROLLBACK (no deploy): UPDATE public.organizations SET
-- public_directory_opt_in = false — every clinic leaves the directory.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS public_directory_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.public_directory_opt_in IS
  'Clinic opt-in to the public directory (/refugios). Read only for org_type = clinic AND verified AND active; shelters and rescue networks are listed on verification alone and ignore it. Default false (migration 0283).';

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
