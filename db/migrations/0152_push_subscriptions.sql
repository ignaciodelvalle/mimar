-- Migration 0152 — push_subscriptions: Web Push (VAPID) subscriptions for owner-side push.
--
-- PWA push v1 (ADR 2026-07-18-native-readiness §4): the notifications table
-- stays the source of truth; Web Push is a best-effort second delivery leg for
-- severity='urgent' rows only (avistajes / hallazgos / custodia). Each row here
-- is one browser PushSubscription (endpoint + client keys) owned by one user.
--
-- DESIGN
-- ------
-- endpoint is globally unique (the push service URL identifies the browser
-- registration). Re-subscribing from the same browser upserts on endpoint.
-- Revocation is soft (revoked_at) so a 410/404 from the push service — or the
-- user toggling push off — leaves an auditable trail instead of deleting the
-- row. Hard deletion happens only via the profiles cascade (account erasure).
--
-- AUTHZ / RLS
-- -----------
-- Drizzle (service-role / BYPASSRLS) is the primary authz gate: the subscribe /
-- revoke server actions run behind requireUserOrRedirect and scope by user_id.
-- RLS policies are the defense-in-depth backstop for any future direct
-- PostgREST surface (mirrors alert_subscriptions, migration 0108):
--
--   SELECT: owner only (user_id = auth.uid())
--   INSERT: owner only
--   UPDATE: owner only
--   DELETE: no policy — rows are soft-revoked, never client-deleted.
--
-- IDEMPOTENCY
-- -----------
-- CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each CREATE POLICY.
-- CREATE INDEX IF NOT EXISTS. Safe to replay.

BEGIN;

-- ============================================================================
-- 1. Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Push service URL for this browser registration. Globally unique: the same
  -- endpoint re-submitted (same browser, new session/user) upserts in place.
  endpoint     text        NOT NULL UNIQUE,
  -- Client public key + auth secret from PushSubscription.getKey(), base64url.
  p256dh       text        NOT NULL,
  auth         text        NOT NULL,
  -- Best-effort browser identification for the user's device list. Optional.
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set on every successful delivery; lets a future cleanup cron drop stale rows.
  last_used_at timestamptz,
  -- Soft revocation: user toggled off, or the push service returned 410/404.
  revoked_at   timestamptz
);

-- ============================================================================
-- 2. Index — fast lookup of a user's active subscriptions (the send path)
-- ============================================================================

CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
  ON public.push_subscriptions (user_id)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- 3. Row Level Security
-- ============================================================================

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT: owner reads own rows only
DROP POLICY IF EXISTS "push_subscriptions read by owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions read by owner"
  ON public.push_subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT: owner inserts own rows only
DROP POLICY IF EXISTS "push_subscriptions insert by owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions insert by owner"
  ON public.push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE: owner updates own rows only
DROP POLICY IF EXISTS "push_subscriptions update by owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions update by owner"
  ON public.push_subscriptions
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMIT;
