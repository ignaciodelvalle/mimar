-- 0125 — enable RLS deny-all on notification_dead_letter.
--
-- Migration 0124 created public.notification_dead_letter (the recoverable
-- failed-notification payload surface for the createNotification() service) but
-- did NOT enable Row Level Security. The `payload` jsonb can carry owner-facing
-- PII (notification body / actor metadata), so leaving RLS off exposes it on the
-- anon PostgREST surface — the exact class the RLS coverage contract
-- (__tests__/rls/coverage.test.ts) exists to prevent.
--
-- The table is written by the service and drained by a retry cron, both via
-- Drizzle / service-role (BYPASSRLS) — no anon or authenticated PostgREST access
-- is ever needed. Deny-all backstop (RLS enabled, no permissive policy), the same
-- posture as event_notification_outbox (0086) and the advisor tables (0113).
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled. No data
-- touched. No -- dim:no-transaction needed.

BEGIN;

ALTER TABLE public.notification_dead_letter ENABLE ROW LEVEL SECURITY;

COMMIT;
