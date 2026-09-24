-- 0142 — composite (event_type, recorded_at) index on pet_events
-- (viz-suite wave 0 enabler #3, plan docs/plans/viz-suite.md).
--
-- The reporting-lag mode (wave 2) aggregates per-unit
-- median(recorded_at - occurred_at) filtered by event_type, and every
-- transaction-time (basis=transaction) window scan filters/sorts on
-- recorded_at — which has NO index today (verified in the viz-suite "regalado"
-- audit: both timestamps are NOT NULL, only occurred_at-side indexes exist).
-- Composite with event_type first to match the layer loaders' access pattern
-- (they always filter by type, then window).
--
-- Forward-only, immutable. Applying to the remote DB is Ignacio-gated
-- (CLAUDE.md norm) — this file shipping does NOT mean it ran anywhere.

CREATE INDEX IF NOT EXISTS pet_events_event_type_recorded_at_idx
  ON pet_events (event_type, recorded_at);

-- Plain (non-CONCURRENT) build, same as sibling 0122 on this table: the ledger
-- is append-only and the build window on current volumes is short; the remote
-- apply session (Ignacio-gated) can switch to CONCURRENTLY if prod volume
-- warrants it at apply time.
