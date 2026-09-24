-- 0143 — operator_feed_watermarks: per-operator "Novedades" feed watermark
-- (viz-suite Wave 1, plan docs/plans/viz-suite.md — "Novedades").
--
-- Backs the session-start "Novedades" orientation feed on the /gob and /admin
-- operator HOMEs ("esto cambió en tu jurisdicción desde tu última visita").
-- One row per operator records the transaction-time (recorded_at) high-water
-- mark of the events they have acknowledged via the card's explicit
-- "Marcar como visto" button. The feed then shows pet_events with recorded_at
-- STRICTLY GREATER than this mark.
--
-- INVARIANT (core principle #2): this is per-user UI state, NOT an event. The
-- append-only event log (pet_events) is never touched by the feed — the
-- watermark is the only thing that moves, and only on an explicit user action
-- (never on render, so a refresh cannot clear the feed).
--
-- DESIGN
-- ------
--   user_id is the PRIMARY KEY (exactly one row per operator) and FKs
--   profiles(id) — the canonical app user record (profiles.id = auth.users.id) —
--   ON DELETE CASCADE so a removed operator's watermark is cleaned up with them.
--
-- AUTHZ / RLS
-- -----------
--   Drizzle (service-role / BYPASSRLS) is the primary gate; the server action
--   markNovedadesSeenAction upserts under requireAdminOrGovtOrRedirect. The RLS
--   policies below are the defense-in-depth backstop for any future direct
--   PostgREST surface. A watermark is PURELY PERSONAL UI state, so — unlike
--   alert_subscriptions (0108) — there is NO admin-read branch: owner-only for
--   every operation. No DELETE policy: the only deletion path is the profile
--   CASCADE above (mirrors pet_achievement_views' write-once omission, 0046).
--
-- IDEMPOTENCY
-- -----------
--   CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each CREATE POLICY.
--   The migration runner (scripts/migrate.ts) wraps the whole file in one
--   transaction by default (recent convention, cf. 0141/0142 — no explicit
--   BEGIN/COMMIT), so the table + policies apply atomically. Safe to replay.
--
-- Forward-only, immutable. Applying to the remote DB is Ignacio-gated
-- (CLAUDE.md norm) — this file shipping does NOT mean it ran anywhere.

CREATE TABLE IF NOT EXISTS public.operator_feed_watermarks (
  user_id               uuid        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_seen_recorded_at timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.operator_feed_watermarks ENABLE ROW LEVEL SECURITY;

-- SELECT: owner reads only their own watermark row.
DROP POLICY IF EXISTS "operator_feed_watermarks read by owner" ON public.operator_feed_watermarks;
CREATE POLICY "operator_feed_watermarks read by owner"
  ON public.operator_feed_watermarks
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT: owner inserts only their own watermark row.
DROP POLICY IF EXISTS "operator_feed_watermarks insert by owner" ON public.operator_feed_watermarks;
CREATE POLICY "operator_feed_watermarks insert by owner"
  ON public.operator_feed_watermarks
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE: owner advances only their own watermark.
DROP POLICY IF EXISTS "operator_feed_watermarks update by owner" ON public.operator_feed_watermarks;
CREATE POLICY "operator_feed_watermarks update by owner"
  ON public.operator_feed_watermarks
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
