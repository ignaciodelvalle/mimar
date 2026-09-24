-- 0244 — user_surface_visits: per-user "have you been here" watermark, shared
-- across the /gob first-run onboarding checklist steps (T4-O3,
-- docs/plans/gob-onboarding-scoping.md).
--
-- Renumbered from 0243 (2026-09-22): T4-I1 also wrote a 0243_*.sql migration
-- and both landed on the shared local DB under that number before either was
-- committed. This file's content is unchanged — only the filename/number.
--
-- The scoping doc's shared-infra note asks for ONE table so the checklist's
-- G1 (conocé tu alcance), G2 (recorré el panorama) and G4 (revisá la cola de
-- casos) steps — each "first visit to a surface" — don't each invent their
-- own bookkeeping. Rows are keyed by (user_id, surface); `first_visited_at`
-- is set once and never moves, `last_seen_at` advances on every later visit.
--
-- UNLIKE operator_feed_watermarks (migration 0143), this is recorded
-- AUTOMATICALLY on render — it answers "have you ever been here", not "what
-- have you acknowledged", so there is no explicit user action to gate it on.
--
-- AUTHZ / RLS
-- -----------
--   Drizzle (service-role / BYPASSRLS) is the primary gate; the checklist
--   reads/writes go through requireGobReadAccessOrRedirect-gated server code
--   (lib/infra/surface-visits.ts). The RLS policies below are the
--   defense-in-depth backstop for any future direct PostgREST surface — same
--   posture as operator_feed_watermarks: purely personal UI state, so
--   owner-only for every operation, no admin-read branch, no DELETE policy
--   (the only deletion path is the profile CASCADE below).
--
-- IDEMPOTENCY
-- -----------
--   CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each CREATE
--   POLICY. Wrapped in one transaction by the migration runner (no explicit
--   BEGIN/COMMIT needed). Safe to replay.
--
-- Forward-only, immutable. Applying to the remote DB is Ignacio-gated
-- (CLAUDE.md norm) — this file shipping does NOT mean it ran anywhere.

CREATE TABLE IF NOT EXISTS public.user_surface_visits (
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  surface          text        NOT NULL,
  first_visited_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface)
);

ALTER TABLE public.user_surface_visits ENABLE ROW LEVEL SECURITY;

-- SELECT: owner reads only their own visit rows.
DROP POLICY IF EXISTS "user_surface_visits read by owner" ON public.user_surface_visits;
CREATE POLICY "user_surface_visits read by owner"
  ON public.user_surface_visits
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT: owner records only their own first visit.
DROP POLICY IF EXISTS "user_surface_visits insert by owner" ON public.user_surface_visits;
CREATE POLICY "user_surface_visits insert by owner"
  ON public.user_surface_visits
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE: owner advances only their own last_seen_at.
DROP POLICY IF EXISTS "user_surface_visits update by owner" ON public.user_surface_visits;
CREATE POLICY "user_surface_visits update by owner"
  ON public.user_surface_visits
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
