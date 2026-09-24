-- Migration 0111 — alert_firings: alert inbox + triage lifecycle (Paquete K).
--
-- WHY
-- ---
-- alert_subscriptions (migration 0108) only model the "is this threshold
-- breached right now?" boolean surfaced on /admin/programa. They have no
-- lifecycle: an admin cannot acknowledge, investigate, contact the authority,
-- or close an alert. This migration adds a dedicated, ADDITIVE table that
-- records one row per OPEN firing and carries it through a triage state
-- machine. No existing table is altered.
--
-- STATE MACHINE (status column)
-- -----------------------------
--   disparada → reconocida → en_investigacion → autoridad_contactada → resuelta
--   disparada / reconocida → descartada
-- Transitions are validated in lib/metrics/alert-firing.ts#nextStatus and the
-- audit trail lives in the *_at / *_by columns — there is intentionally NO new
-- AUDIT_LOG_ACTIONS entry (decision K-D4).
--
-- DEDUP
-- -----
-- At most ONE open firing per (subscription_id, jurisdiction) at a time. This
-- is enforced in application code (shouldOpenFiring) backed by the
-- (subscription_id, status) index below; a partial unique index is avoided
-- because jurisdiction can legitimately be NULL (global metrics) and the open
-- set is multi-valued.
--
-- AUTHZ / RLS
-- -----------
-- Drizzle (service-role / BYPASSRLS) is the primary authz gate — admin-only
-- reads/writes go through app/actions/alert-firings.ts. RLS here is the
-- defense-in-depth backstop for any future direct PostgREST surface: deny-all
-- for the authenticated role (no permissive policy → no anon/PostgREST access).
-- Classified in __tests__/rls/coverage.test.ts → RLS_REQUIRED.
--
-- IDEMPOTENCY
-- -----------
-- CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS; DROP POLICY IF EXISTS
-- before each CREATE POLICY. Safe to replay.

BEGIN;

-- ============================================================================
-- 1. Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.alert_firings (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id         uuid        REFERENCES public.alert_subscriptions(id) ON DELETE SET NULL,
  metric_key              text        NOT NULL,
  direction               text        NOT NULL,
  threshold               numeric     NOT NULL,
  observed_value          numeric     NOT NULL,
  jurisdiction_province   text,
  jurisdiction_locality   text,
  status                  text        NOT NULL DEFAULT 'disparada',
  fired_at                timestamptz NOT NULL DEFAULT now(),
  acknowledged_at         timestamptz,
  acknowledged_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  investigation_code      text,
  contacted_govt_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  contacted_at            timestamptz,
  resolved_at             timestamptz,
  resolved_by             uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes                   text,

  CONSTRAINT alert_firings_metric_key_valid CHECK (
    metric_key IN (
      'active_zoonosis',
      'eno_sla_ontime_pct',
      'queue_oldest_days',
      'sterilization_coverage_pct',
      'microchip_penetration_pct',
      'open_welfare_reports'
    )
  ),

  CONSTRAINT alert_firings_direction_valid CHECK (
    direction IN ('above', 'below')
  ),

  CONSTRAINT alert_firings_status_valid CHECK (
    status IN (
      'disparada',
      'reconocida',
      'en_investigacion',
      'autoridad_contactada',
      'resuelta',
      'descartada'
    )
  ),

  CONSTRAINT alert_firings_province_valid CHECK (
    jurisdiction_province IS NULL OR jurisdiction_province IN (
      'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba','Corrientes',
      'Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja','Mendoza','Misiones',
      'Neuquén','Río Negro','Salta','San Juan','San Luis','Santa Cruz','Santa Fe',
      'Santiago del Estero','Tierra del Fuego','Tucumán'
    )
  )
);

-- ============================================================================
-- 2. Indexes
-- ============================================================================

-- Inbox ordering + status filter.
CREATE INDEX IF NOT EXISTS alert_firings_status_fired_idx
  ON public.alert_firings (status, fired_at);

-- Dedup: fast lookup of a subscription's open firings.
CREATE INDEX IF NOT EXISTS alert_firings_subscription_status_idx
  ON public.alert_firings (subscription_id, status);

-- ============================================================================
-- 3. Row Level Security — deny-all backstop (defense in depth)
-- ============================================================================
-- No permissive policy is created: with RLS enabled and zero policies, every
-- row is invisible/uneditable through the PostgREST surface. Admin access is
-- served exclusively by the Drizzle BYPASSRLS connection in the server actions.

ALTER TABLE public.alert_firings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_firings deny all" ON public.alert_firings;

COMMIT;
