-- dim:no-transaction
-- Migration 0090: V1-8 performance — missing FK / filter indexes (national scale)
--
-- Background
-- ----------
-- A national-scale performance audit flagged hot-path queries doing sequential
-- scans on unindexed foreign keys. This migration adds the three indexes that
-- were genuinely missing after verification against pg_indexes and the existing
-- migration tree. The other FK indexes named in the audit
-- (pet_events.case_id, notifications.related_case_id, welfare_reports.case_id,
-- welfare_reports.reporter_organization_id, custody_dispute_parties.dispute_id /
-- party_user_id, and the custody_disputes pet/jurisdiction indexes) ALREADY
-- shipped in migrations 0025, 0033 and 0035; they are only mirrored into
-- db/schema.ts in this change to fix pre-existing schema↔migration drift. No SQL
-- is re-issued for them here.
--
-- Why CONCURRENTLY + no-transaction
-- ---------------------------------
-- pet_events is the largest, still-growing table. A plain CREATE INDEX takes an
-- ACCESS EXCLUSIVE-equivalent build lock that blocks writes for the duration of
-- the build — unacceptable on the busiest table once it is large. CREATE INDEX
-- CONCURRENTLY builds without blocking writes, but it CANNOT run inside a
-- transaction block. This file therefore carries the `-- dim:no-transaction`
-- header so scripts/migrate.ts (V0-6 runner) executes it UNwrapped.
--
-- Because a no-transaction file cannot be rolled back on partial failure, every
-- statement is guarded with IF NOT EXISTS and is independently idempotent —
-- safe to re-run from the top after fixing any failure. (A CONCURRENTLY build
-- that fails leaves an INVALID index; re-running with IF NOT EXISTS is a no-op
-- on the name, so drop any leftover invalid index manually before retry — see
-- docs/ops/migrations.md.)
--
-- All three are PARTIAL (WHERE … IS NOT NULL / IS NULL) to keep them small:
-- the nullable FK columns are null on most rows, and the custody filter only
-- needs the live (non-deleted) set.

-- pet_events.recorded_by_user_id — FK lookups (who recorded an event); unindexed
-- → full scan on pet_events, the biggest table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pet_events_recorded_by_user_id_idx
  ON public.pet_events (recorded_by_user_id)
  WHERE recorded_by_user_id IS NOT NULL;

-- pet_events.author_organization_id — FK lookups (which org authored an event,
-- e.g. clinic/refugio attribution); unindexed → full scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pet_events_author_organization_id_idx
  ON public.pet_events (author_organization_id)
  WHERE author_organization_id IS NOT NULL;

-- custody_disputes (pet_id, status) on the live (non-deleted) set. The existing
-- custody_disputes_pet_idx (pet_id, created_at) and one_open_per_pet (open only)
-- do not cover (pet_id, status) filtering for non-open statuses on live rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS custody_disputes_pet_status_idx
  ON public.custody_disputes (pet_id, status)
  WHERE deleted_at IS NULL;
