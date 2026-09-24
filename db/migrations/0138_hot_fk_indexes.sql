-- dim:no-transaction
-- Migration 0138: index unindexed foreign keys on the hot tables (advisor
-- `unindexed_foreign_keys`, national-scale performance).
--
-- BACKGROUND
-- ----------
-- Every FK column below is `ON DELETE SET NULL` referencing profiles (or
-- organizations). When a parent row is deleted — which happens for real in the
-- subject-rights erasure flow (erase_subject_data, migrations 0129-0131) — and
-- on organization removal, Postgres must locate every referencing child row to
-- null the column. Without an index on the FK column that is a SEQUENTIAL SCAN
-- of the child table per deleted parent. The child tables here (pets, cases,
-- welfare_reports) are hot and still growing at national scale. Several columns
-- are also operator/org inbox filters ("cases my org opened", "reports I
-- triaged"), so the index doubles as a query-path index.
--
-- WHY CONCURRENTLY (mirrors migration 0090)
-- -----------------------------------------
-- A plain CREATE INDEX takes an ACCESS EXCLUSIVE lock for the whole build —
-- unacceptable on these busy tables in production. CREATE INDEX CONCURRENTLY
-- avoids the write lock but cannot run inside a transaction block, so this file
-- carries the `-- dim:no-transaction` directive (the migrate runner then sends
-- each statement outside BEGIN/COMMIT). IF NOT EXISTS keeps it re-runnable.
--
-- SCOPE (8 indexes; deliberately NOT the long tail)
-- -------------------------------------------------
-- Restricted to the four hot tables (pets / pet_events / welfare_reports /
-- cases). pet_events already has full FK-index coverage (migrations 0038/0090/
-- 0096), so nothing is added there. The remaining ~49 unindexed FKs live on
-- lower-traffic operator/reference tables and are intentionally deferred.
-- welfare_reports.derived_by_user_id is also deferred: welfare derivation-to-org
-- is the rarest operator action and the column is neither a hot query filter nor
-- a frequent-delete cascade target.

-- pets — created_by / updated_by reference the owner (a citizen), the profile
-- most frequently deleted by subject-rights erasure; the scan is on the hot
-- pets table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pets_created_by_idx
  ON public.pets (created_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS pets_updated_by_idx
  ON public.pets (updated_by);

-- cases — opened_by_user_id can be a citizen denuncia opener (erasure cascade)
-- and backs "cases I opened"; closed_by_user_id backs the erasure cascade on
-- the hot cases table; opened_by_organization_id backs the org case inbox
-- filter and the organization-removal cascade.
CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_opened_by_user_id_idx
  ON public.cases (opened_by_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_closed_by_user_id_idx
  ON public.cases (closed_by_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cases_opened_by_organization_id_idx
  ON public.cases (opened_by_organization_id);

-- welfare_reports — triaged_by / moderation_resolved_by / moderation_escalated_by
-- back the operator triage and moderation queues ("assigned to me", "resolved by
-- me", "escalated by me") and the erasure cascade on the hot reports table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS welfare_reports_triaged_by_user_id_idx
  ON public.welfare_reports (triaged_by_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS welfare_reports_moderation_resolved_by_user_id_idx
  ON public.welfare_reports (moderation_resolved_by_user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS welfare_reports_moderation_escalated_by_user_id_idx
  ON public.welfare_reports (moderation_escalated_by_user_id);
