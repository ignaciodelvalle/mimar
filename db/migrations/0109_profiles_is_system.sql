-- Migration 0109 — profiles.is_system: explicit system/service-account flag (C21).
--
-- WHY
-- ---
-- The admin rosters (/admin/admins) and the last-admin guard previously decided
-- whether an account was a machine/service account by inspecting its display
-- name (or email) for a literal `system:` prefix. That heuristic is brittle:
--   1. The admin roster pages enumerate auth users via
--      `supabase.auth.admin.listUsers({ perPage: 200 })`. Beyond 200 users the
--      email field comes back blank, so the `email.startsWith("system:")` half
--      of the heuristic silently fails.
--   2. A human display name that happens to start with `system:` would be
--      misclassified as a service account.
-- This migration replaces the heuristic with a first-class boolean column.
--
-- BACKFILL
-- --------
-- Existing service accounts were created with a `system:%` display name, so we
-- backfill the flag from that same convention ONCE. New service accounts are
-- expected to set is_system = true explicitly at creation time.
--
-- IDEMPOTENCY
-- -----------
-- ADD COLUMN IF NOT EXISTS + an UPDATE guarded only by the LIKE predicate
-- (re-running sets the same rows to the same value). Safe to replay.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- Backfill: flag legacy service/system accounts named "system:%".
UPDATE public.profiles
SET is_system = true
WHERE display_name LIKE 'system:%';

COMMIT;
