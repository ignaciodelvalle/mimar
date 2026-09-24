-- 0141 — partial expression index for the org-scoped overdue-checkins driver
-- (staging-readiness triage #42, 2026-07-12).
--
-- Query confirmed at lib/analytics/org-dashboard.ts:723-737
-- (countOverdueCheckins), the DRIVE subquery for the org-scoped-first
-- overdue-checkin shape (never let the fast-growing `reminders` table sit in
-- the outer position — see the function's doc comment):
--
--   SELECT DISTINCT e.pet_id
--   FROM pet_events e
--   WHERE e.event_type = 'adoption_finalized'
--     AND e.payload->>'previous_owner_organization_id' = ${orgId}
--
-- Without a supporting index this is a sequential scan of pet_events (the
-- largest table) per org-dashboard page load. The expression below matches
-- the query's access path verbatim: `(payload->>'previous_owner_organization_id')`,
-- same `->>` text-extraction operator already used by the sibling payload
-- indexes in migration 0081/0118, so no query rewrite is needed for the
-- planner to pick it up.
--
-- Partial on event_type = 'adoption_finalized': mirrors
-- pet_events_amended_target_idx (migration 0118) — only rows that can ever
-- carry this payload key participate, keeping the index small at national
-- scale instead of indexing every event_type's payload blob.
--
-- Plain CREATE INDEX (not CONCURRENTLY): follows the deliberate precedent set
-- in migration 0081 for pet_events payload expression indexes — a brief
-- ShareLock during build is accepted on this low-write audit table so the
-- migration stays a plain transactional statement (no CONCURRENTLY /
-- no-transaction directive required). IF NOT EXISTS keeps it re-runnable.

CREATE INDEX IF NOT EXISTS pet_events_payload_previous_owner_org_idx
  ON public.pet_events ((payload->>'previous_owner_organization_id'))
  WHERE event_type = 'adoption_finalized';
