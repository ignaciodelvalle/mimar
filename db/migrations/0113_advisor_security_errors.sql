-- Migration 0113 — Remediate the 5 Supabase security-advisor ERRORs (2026-06-24).
--
-- SOURCE
-- ------
-- Supabase security advisor run against project DIM (mardurkdicugnzmpirjd),
-- 2026-06-24: 5 ERROR (1 security_definer_view + 4 rls_disabled_in_public).
-- Plan: docs/superpowers/plans/2026-06-24-supabase-advisor-errors.md.
--
-- WHAT
-- ----
--   (1) DROP the obsolete compat view public.pets_with_identifiers
--       (security_definer_view). Its legacy chip/tattoo columns were dropped in
--       0084; it has ZERO references in app/tests/scripts (verified 2026-06-24,
--       only migration 0056 that creates it + a comment in db/schema.ts).
--   (2-5) ENABLE RLS deny-all (RLS ON, no policy) on four tables flagged
--       rls_disabled_in_public. The app reaches all four exclusively through
--       Drizzle / service-role (BYPASSRLS) — verified: no anonymous supabase-js
--       client reads them — so deny-all has ZERO impact on the app and only
--       closes the anonymous PostgREST read surface. This is the same pattern
--       as 0086 PART 6 (eno_processing_queue, event_notification_outbox).
--
-- SUPERSEDES
-- ----------
-- 0086 PART 7 documented rate_limit_buckets, _dim_migrations,
-- govt_business_rules and jurisdictions_census as INTENTIONAL RLS exclusions
-- ("not PII"). The advisor is right anyway: RLS-off + PostgREST exposure means
-- anyone with the anon/publishable key could SELECT * over them. This migration
-- consciously REVERSES that exclusion toward deny-all (defense in depth). The
-- exclusion in 0086 PART 7 is therefore SUPERSEDED for these four tables;
-- __tests__/rls/coverage.test.ts moves them from RLS_INTENTIONALLY_EXCLUDED to
-- RLS_REQUIRED in the same PR. Migrations are immutable — 0086 is NOT edited.
--
-- SAFETY
-- ------
-- Forward-only, idempotent: DROP VIEW IF EXISTS is a no-op if absent;
-- ENABLE ROW LEVEL SECURITY is a no-op if already enabled. No data is touched;
-- pet_events append-only is unaffected. No -- dim:no-transaction needed (no
-- CREATE INDEX CONCURRENTLY / ALTER TYPE).

BEGIN;

-- (1) ERROR security_definer_view — pets_with_identifiers.
DROP VIEW IF EXISTS public.pets_with_identifiers;

-- (2-5) ERROR rls_disabled_in_public — deny-all (RLS ON, no policy).
-- App accesses these via Drizzle / service-role (BYPASSRLS); deny-all only
-- closes the anonymous PostgREST surface.
ALTER TABLE public.rate_limit_buckets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._dim_migrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.govt_business_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jurisdictions_census ENABLE ROW LEVEL SECURITY;

COMMIT;
