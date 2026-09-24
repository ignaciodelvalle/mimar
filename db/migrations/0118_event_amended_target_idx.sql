-- 0118 — partial expression index for the SQL amendment overlay
-- (projection-cron audit 2026-07-03 A2).
--
-- KPI aggregates (rabies coverage, trends, choropleths) now COALESCE the
-- latest event_amended correction over the raw payload via a correlated
-- subquery keyed on payload->>'target_event_id' (lib/infra/amendment-sql.ts).
-- Without this index every candidate row probes ALL event_amended rows; with
-- it the probe is an index lookup. Partial on event_type keeps it tiny —
-- only amendment rows participate.

CREATE INDEX IF NOT EXISTS pet_events_amended_target_idx
  ON pet_events ((payload->>'target_event_id'))
  WHERE event_type = 'event_amended';
