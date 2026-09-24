-- Migration 0110 — audit_log: leading performed_at index for default sort (WS-PERF P1).
--
-- WHY
-- ---
-- The /admin/auditoria page (and its audit-trail helpers) orders audit_log by
-- (performed_at DESC, id DESC) on every unfiltered request. The table already
-- has composite indexes whose leading columns are actor_user_id and action
-- respectively — neither is useful for an unfiltered ORDER BY. Without a
-- leading performed_at index Postgres falls back to a full sequential scan +
-- sort, which on the seeded ~150k-row table took ~40 s to return the first
-- page. This index reduces that to a fast index scan.
--
-- IDEMPOTENCY
-- -----------
-- CREATE INDEX IF NOT EXISTS is safe to replay.

CREATE INDEX IF NOT EXISTS audit_log_performed_at_idx
  ON public.audit_log (performed_at DESC, id DESC);
