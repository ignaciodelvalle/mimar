-- Migration 0108 — alert_subscriptions: threshold alert subscriptions for /admin/programa.
--
-- Implements the deferred Paquete H item: allows admin users to subscribe to
-- threshold alerts on key program metrics. Alerts are evaluated server-side
-- and surfaced as breaching cards on the /admin/programa dashboard.
--
-- DESIGN
-- ------
-- Each row is a single subscription owned by one actor_user_id (admin). When
-- the current metric value crosses the threshold in the configured direction
-- ('above' or 'below'), the subscription is considered "breaching".
--
-- Metrics covered (metric_key):
--   active_zoonosis             — count of active zoonosis cases
--   eno_sla_ontime_pct          — ENO SLA on-time delivery percentage
--   queue_oldest_days           — days since oldest pending approval request (global)
--   sterilization_coverage_pct  — sterilization coverage rate (%)
--   microchip_penetration_pct   — microchip penetration rate (%)
--   open_welfare_reports        — count of open welfare reports
--
-- SCOPE
-- -----
-- jurisdiction_province / jurisdiction_locality are optional. When set, the
-- metric is fetched scoped to that jurisdiction. queue_oldest_days is always
-- global regardless (the metric has no jurisdiction dimension — see
-- alert-evaluation.ts for the documented caveat).
--
-- AUTHZ / RLS
-- -----------
-- Drizzle (service-role / BYPASSRLS) is the primary authz gate.
-- RLS policies are the defense-in-depth backstop for any future direct
-- PostgREST surface.
--
--   SELECT: owner OR admin
--   INSERT: owner only (actor_user_id = auth.uid())
--   UPDATE: owner only
--   DELETE: owner only
--   Admin write: handled via Drizzle BYPASSRLS — no permissive INSERT/UPDATE/DELETE
--               policy for admin role (admin never needs direct PostgREST write).
--
-- IDEMPOTENCY
-- -----------
-- CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each CREATE POLICY.
-- CREATE INDEX IF NOT EXISTS. Safe to replay.

BEGIN;

-- ============================================================================
-- 1. Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.alert_subscriptions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  metric_key            text        NOT NULL,
  direction             text        NOT NULL,
  threshold             numeric     NOT NULL,
  jurisdiction_province text,
  jurisdiction_locality text,
  label                 text,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alert_subscriptions_metric_key_valid CHECK (
    metric_key IN (
      'active_zoonosis',
      'eno_sla_ontime_pct',
      'queue_oldest_days',
      'sterilization_coverage_pct',
      'microchip_penetration_pct',
      'open_welfare_reports'
    )
  ),

  CONSTRAINT alert_subscriptions_direction_valid CHECK (
    direction IN ('above', 'below')
  ),

  CONSTRAINT alert_subscriptions_province_valid CHECK (
    jurisdiction_province IS NULL OR jurisdiction_province IN (
      'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba','Corrientes',
      'Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja','Mendoza','Misiones',
      'Neuquén','Río Negro','Salta','San Juan','San Luis','Santa Cruz','Santa Fe',
      'Santiago del Estero','Tierra del Fuego','Tucumán'
    )
  )
);

-- ============================================================================
-- 2. Partial index — fast lookup of a user's active subscriptions
-- ============================================================================

CREATE INDEX IF NOT EXISTS alert_subscriptions_actor_active_idx
  ON public.alert_subscriptions (actor_user_id)
  WHERE is_active = true;

-- ============================================================================
-- 3. Row Level Security
-- ============================================================================

ALTER TABLE public.alert_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT: owner reads own rows OR admin reads all
DROP POLICY IF EXISTS "alert_subscriptions read by owner or admin" ON public.alert_subscriptions;
CREATE POLICY "alert_subscriptions read by owner or admin"
  ON public.alert_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    actor_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
        AND p.deactivated_at IS NULL
    )
  );

-- INSERT: owner inserts own rows only
DROP POLICY IF EXISTS "alert_subscriptions insert by owner" ON public.alert_subscriptions;
CREATE POLICY "alert_subscriptions insert by owner"
  ON public.alert_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (actor_user_id = auth.uid());

-- UPDATE: owner updates own rows only
DROP POLICY IF EXISTS "alert_subscriptions update by owner" ON public.alert_subscriptions;
CREATE POLICY "alert_subscriptions update by owner"
  ON public.alert_subscriptions
  FOR UPDATE
  TO authenticated
  USING (actor_user_id = auth.uid())
  WITH CHECK (actor_user_id = auth.uid());

-- DELETE: owner deletes own rows only
DROP POLICY IF EXISTS "alert_subscriptions delete by owner" ON public.alert_subscriptions;
CREATE POLICY "alert_subscriptions delete by owner"
  ON public.alert_subscriptions
  FOR DELETE
  TO authenticated
  USING (actor_user_id = auth.uid());

COMMIT;
