-- dim:no-transaction
-- Migration 0096: performance indexes — round 2 (HIGH + MEDIUM priority)
--
-- Background
-- ----------
-- Query-performance audit (docs/perf/query-optimization-plan-2026-06.md §1.3)
-- identified hot-path queries doing sequential scans on unindexed columns.
-- This migration adds 9 new indexes (4 HIGH, 5 MEDIUM priority) and drops the
-- now-superseded appointments_pet_idx.
--
-- Why CONCURRENTLY + no-transaction
-- ----------------------------------
-- CREATE INDEX CONCURRENTLY builds without blocking concurrent writes. It cannot
-- run inside a transaction block, so this file carries the `-- dim:no-transaction`
-- header. Every statement is guarded with IF NOT EXISTS / IF EXISTS for idempotency
-- — safe to re-run after any partial failure.
--
-- appointments_pet_idx drop
-- --------------------------
-- The new appointments_pet_status_idx (pet_id, status, created_at) fully covers
-- every query that hit appointments_pet_idx (pet_id, created_at). A code search
-- confirms no query uses (pet_id, created_at) without also filtering on status;
-- the old index is purely redundant write overhead.

-- ============================================================================
-- HIGH priority — motivating query shown for each
-- ============================================================================

-- notifications.related_pet_id: lost-pet / disease dedup scans
-- (lib/events-repository.ts:300, app/actions/events.ts:1329)
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_related_pet_idx
  ON public.notifications (related_pet_id)
  WHERE related_pet_id IS NOT NULL;

-- appointments.(service_offering_id, status): org servicios booking summary
-- (app/org/[orgToken]/servicios/[offeringToken]/page.tsx:80-86)
CREATE INDEX CONCURRENTLY IF NOT EXISTS appointments_service_offering_idx
  ON public.appointments (service_offering_id, status);

-- welfare_reports.(province, locality, status) for active reports:
-- government welfare inbox main query (lib/govt-dashboards.ts:905-953)
CREATE INDEX CONCURRENTLY IF NOT EXISTS welfare_reports_jurisdiction_status_idx
  ON public.welfare_reports (jurisdiction_province, jurisdiction_locality, status)
  WHERE status NOT IN ('closed', 'invalid', 'duplicate');

-- welfare_reports.(province, locality, created_at) for open reports:
-- overdue queue sort (lib/govt-dashboards.ts:948)
CREATE INDEX CONCURRENTLY IF NOT EXISTS welfare_reports_open_created_at_idx
  ON public.welfare_reports (jurisdiction_province, jurisdiction_locality, created_at)
  WHERE status = 'open';

-- ============================================================================
-- MEDIUM priority
-- ============================================================================

-- cases.applicant_user_id: owner adoption-application lookup
-- (lib/owner-dashboard.ts — adoption applications per user)
CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_applicant_user_idx
  ON public.cases (applicant_user_id);

-- cases.welfare_report_id: FK lookup from decomiso flow
-- (lib/decomiso.ts:677)
CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_welfare_report_idx
  ON public.cases (welfare_report_id)
  WHERE welfare_report_id IS NOT NULL;

-- cases.custody_dispute_id: FK lookup from custody-disputes flow
-- (lib/custody-disputes.ts:291, 560, 687)
CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_custody_dispute_idx
  ON public.cases (custody_dispute_id)
  WHERE custody_dispute_id IS NOT NULL;

-- approval_requests.target_organization_id: admin proposal lookup
-- (lib/admin-proposals.ts:204)
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_requests_target_org_idx
  ON public.approval_requests (target_organization_id)
  WHERE target_organization_id IS NOT NULL;

-- reminders.(pet_id, reminder_type, due_at): medication / checkin lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS reminders_pet_type_due_idx
  ON public.reminders (pet_id, reminder_type, due_at);

-- ============================================================================
-- appointments.(pet_id, status, created_at): replaces appointments_pet_idx
-- ============================================================================

-- New composite covers the pet-detail confirmed-turnos query
-- (app/(app)/mis-mascotas/[publicToken]/page.tsx:888-893: pet_id + status + time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS appointments_pet_status_idx
  ON public.appointments (pet_id, status, created_at);

-- Drop the superseded (pet_id, created_at) index — fully covered by the new one
DROP INDEX CONCURRENTLY IF EXISTS public.appointments_pet_idx;
