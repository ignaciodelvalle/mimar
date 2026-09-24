-- Migration 0095: DB hygiene — drop duplicate indexes and FK constraints
--
-- Background
-- ----------
-- The database accumulated duplicate schema objects in two ways:
--
--   1. Eight duplicate INDEXES: push-era naming (public_*_deleted_idx) that were
--      superseded by migration-named twins (pets_deleted_idx, etc.) or non-unique
--      indexes fully covered by UNIQUE constraints on the same columns.
--
--   2. Twenty-eight duplicate FK CONSTRAINTS: every FK that was later re-created by
--      a migration already had a push-generated twin with the `_fkey` suffix. Every
--      INSERT/UPDATE on the affected tables validated the constraint twice with zero
--      additional safety benefit.
--
-- This migration is idempotent (DROP IF EXISTS / DO ... IF NOT EXISTS guards) and
-- runs inside a transaction (no -- dim:no-transaction directive needed — plain DDL,
-- no CONCURRENTLY).
--
-- Verification (before authoring this file)
-- ------------------------------------------
-- Canonical twin confirmed for each dropped index via pg_indexes; duplicate FK
-- pairs enumerated from pg_constraint (contype='f', grouped by conrelid+conkey+
-- confrelid having count>1) and the kept `_fk` twin verified to carry the same
-- pg_get_constraintdef definition.

-- ============================================================================
-- Part 1 — Drop 8 duplicate indexes
-- ============================================================================

-- custody_disputes: public_custody_disputes_deleted_idx is superseded by
-- custody_disputes_deleted_idx (same predicate: deleted_at IS NOT NULL)
DROP INDEX IF EXISTS public.public_custody_disputes_deleted_idx;

-- pet_identifications: public_pet_identifications_deleted_idx is superseded by
-- pet_identifications_deleted_idx (same predicate)
DROP INDEX IF EXISTS public.public_pet_identifications_deleted_idx;

-- pets: public_pets_deleted_idx is superseded by pets_deleted_idx (same predicate)
DROP INDEX IF EXISTS public.public_pets_deleted_idx;

-- profiles: public_profiles_deleted_idx is superseded by profiles_deleted_idx
-- (same predicate)
DROP INDEX IF EXISTS public.public_profiles_deleted_idx;

-- foster_volunteers: foster_volunteers_user_idx (btree user_id) is fully covered
-- by the UNIQUE constraint foster_volunteers_user_id_unique (same column)
DROP INDEX IF EXISTS public.foster_volunteers_user_idx;

-- libreta_share_tokens: libreta_share_tokens_token_idx (btree share_token) is
-- fully covered by libreta_share_tokens_share_token_unique (same column)
DROP INDEX IF EXISTS public.libreta_share_tokens_token_idx;

-- organization_invitations: org_invitations_token_idx (btree invitation_token) is
-- fully covered by organization_invitations_invitation_token_unique (same column)
DROP INDEX IF EXISTS public.org_invitations_token_idx;

-- organization_memberships: organization_memberships_active_idx
-- (btree organization_id, user_id WHERE left_at IS NULL) is fully covered by
-- organization_memberships_active_unique (same columns + same predicate, UNIQUE)
DROP INDEX IF EXISTS public.organization_memberships_active_idx;

-- ============================================================================
-- Part 2 — Drop 28 duplicate _fkey FK constraints (push-era twins)
-- ============================================================================
-- Each ALTER TABLE drops the push-generated `_fkey` constraint; the migration-
-- generated `_fk` twin (identical definition) remains and enforces the same rule.

-- appointments (5 pairs)
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_organization_id_fkey;
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_outcome_event_id_fkey;
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_attended_by_user_id_fkey;
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_cancelled_by_user_id_fkey;
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_service_offering_id_fkey;

-- approval_requests (2 pairs)
ALTER TABLE public.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_decided_by_user_id_fkey;
ALTER TABLE public.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_initiated_by_user_id_fkey;

-- audit_log (4 pairs)
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_approval_request_id_fkey;
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_target_govt_assignment_id_fkey;
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_target_organization_id_fkey;
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_target_user_id_fkey;

-- cases (1 pair)
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_primary_pet_id_fkey;

-- custody_dispute_parties (3 pairs)
ALTER TABLE public.custody_dispute_parties DROP CONSTRAINT IF EXISTS custody_dispute_parties_party_organization_id_fkey;
ALTER TABLE public.custody_dispute_parties DROP CONSTRAINT IF EXISTS custody_dispute_parties_added_by_user_id_fkey;
ALTER TABLE public.custody_dispute_parties DROP CONSTRAINT IF EXISTS custody_dispute_parties_party_user_id_fkey;

-- custody_disputes (5 pairs)
ALTER TABLE public.custody_disputes DROP CONSTRAINT IF EXISTS custody_disputes_raised_by_org_id_fkey;
ALTER TABLE public.custody_disputes DROP CONSTRAINT IF EXISTS custody_disputes_raising_event_id_fkey;
ALTER TABLE public.custody_disputes DROP CONSTRAINT IF EXISTS custody_disputes_resolution_event_id_fkey;
ALTER TABLE public.custody_disputes DROP CONSTRAINT IF EXISTS custody_disputes_raised_by_user_id_fkey;
ALTER TABLE public.custody_disputes DROP CONSTRAINT IF EXISTS custody_disputes_resolved_by_user_id_fkey;

-- foster_proposals (3 pairs)
ALTER TABLE public.foster_proposals DROP CONSTRAINT IF EXISTS foster_proposals_resolved_ownership_id_fkey;
ALTER TABLE public.foster_proposals DROP CONSTRAINT IF EXISTS foster_proposals_cancelled_by_user_id_fkey;
ALTER TABLE public.foster_proposals DROP CONSTRAINT IF EXISTS foster_proposals_proposed_by_user_id_fkey;

-- govt_assignments (2 pairs)
ALTER TABLE public.govt_assignments DROP CONSTRAINT IF EXISTS govt_assignments_granted_by_user_id_fkey;
ALTER TABLE public.govt_assignments DROP CONSTRAINT IF EXISTS govt_assignments_revoked_by_user_id_fkey;

-- pet_service_dog (2 pairs)
ALTER TABLE public.pet_service_dog DROP CONSTRAINT IF EXISTS pet_service_dog_revoked_by_user_id_fkey;
ALTER TABLE public.pet_service_dog DROP CONSTRAINT IF EXISTS pet_service_dog_verified_by_user_id_fkey;

-- service_offerings (1 pair)
ALTER TABLE public.service_offerings DROP CONSTRAINT IF EXISTS service_offerings_reviewed_by_user_id_fkey;
