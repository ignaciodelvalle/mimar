-- Migration 0112 — ownerships: general pet_id index (WP1 / P0 demo-readiness).
--
-- WHY
-- ---
-- /admin/programa's fetchDataQuality() runs an orphan-detection
--   NOT EXISTS (SELECT 1 FROM ownerships o WHERE o.pet_id = pets.id)
-- over every active pet. ownerships had only PARTIAL indexes on pet_id (the
-- one-active-owner and one-active-shelter-custody unique indexes, both gated by
-- role + ended_at IS NULL). Those partials do not cover the unfiltered EXISTS,
-- so the planner fell back to a sequential scan of ownerships PER pet — a nested
-- loop that took ~135 s on the seeded ~45k-pet / ~45k-ownership dataset and blew
-- the /admin/programa demo budget (hang / error boundary).
--
-- A plain (pet_id) index turns the orphan check into an index lookup per pet. A
-- foreign key does NOT create an index in Postgres — this is the missing one.
--
-- IDEMPOTENCY
-- -----------
-- CREATE INDEX IF NOT EXISTS is safe to replay.

CREATE INDEX IF NOT EXISTS ownerships_pet_id_idx
  ON public.ownerships (pet_id);
