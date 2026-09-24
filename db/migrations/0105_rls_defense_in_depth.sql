-- RLS defense-in-depth backstop — Wave 5 Item 26 (P0 data security).
-- ==================================================================
--
-- AUTHZ CONTRACT
-- --------------
-- The DIM authz model has two layers (documented in AGENTS.md § Authorization):
--
--   Layer 1 — ACTION EDGE (primary authz):
--     Every mutation and sensitive read goes through a Next.js Server Action
--     backed by Drizzle ORM. Drizzle connects via DATABASE_URL, which resolves
--     to a role with BYPASSRLS (the `postgres` / `service_role` superuser).
--     The action edge enforces session checks, role checks, and ownership
--     checks in TypeScript before any SQL is executed. This is the AUTHORITATIVE
--     gate — it cannot be bypassed from the browser.
--
--   Layer 2 — RLS (defense-in-depth backstop):
--     PostgREST (the supabase-js / publishable-key surface) is subject to
--     PostgreSQL Row Level Security. If a vulnerability in Next.js, a future
--     direct-PostgREST integration, or a misconfigured supabase-js client were
--     ever exposed, RLS is the last line of defense that keeps data isolated
--     at the database level. Service-role and `postgres` connections bypass
--     RLS by design (BYPASSRLS privilege), so these policies NEVER affect
--     the action edge.
--
--   Consequence: enabling or tightening RLS policies CANNOT break the app.
--   The app ONLY talks to the DB via the service-role / BYPASSRLS path.
--
-- SCOPE OF THIS MIGRATION
-- -----------------------
-- Migration 0086_track_rls_in_migrations.sql (V0-4) enabled RLS on all PII
-- tables but left `pet_identifications` and `pet_transfers` as DENY-ALL
-- (no permissive SELECT policies) with the note "server actions only".
--
-- This migration adds read policies for those two tables so that any future
-- RLS-aware path (e.g. a native mobile app, a direct supabase-js integration,
-- or an auditor tool) sees correct tenant isolation rather than a silent
-- deny that could mask misconfiguration. The action edge continues to be
-- the primary authz gate; these policies are backstop only.
--
-- TABLES COVERED
-- --------------
-- • pet_identifications — microchip / ISO subfields / tattoo data (PII,
--   Ley 25.326). Owner of the pet may read; admin may read all.
-- • pet_transfers — transfer offers (PII: recipient email, owner ids, notes).
--   Sender (from_owner) and receiver (to_owner) may read their own transfers;
--   admin may read all.
--
-- IDEMPOTENCY
-- -----------
-- Every policy uses DROP POLICY IF EXISTS before CREATE POLICY.
-- ENABLE ROW LEVEL SECURITY is a no-op when already enabled.
-- Safe to re-run on any DB state.

BEGIN;

-- ===========================================================================
-- pet_identifications
-- ===========================================================================
-- Already has RLS enabled (migration 0086). Adding read policy.

-- Owner reads identifications for their pets (via ownerships).
DROP POLICY IF EXISTS "pet_identifications read by active owner" ON public.pet_identifications;
CREATE POLICY "pet_identifications read by active owner"
  ON public.pet_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.ownerships o
      WHERE o.pet_id = pet_identifications.pet_id
        AND o.owner_user_id = auth.uid()
        AND o.ended_at IS NULL
    )
  );

-- Admin reads all identifications (universal scope — same pattern as cases).
DROP POLICY IF EXISTS "pet_identifications read by admin" ON public.pet_identifications;
CREATE POLICY "pet_identifications read by admin"
  ON public.pet_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
        AND p.deactivated_at IS NULL
    )
  );

-- Govt reads identifications of pets in their jurisdiction (public-health use case).
-- Joins via pets.jurisdiction_province to limit scope to assigned jurisdiction.
DROP POLICY IF EXISTS "pet_identifications read by govt in jurisdiction" ON public.pet_identifications;
CREATE POLICY "pet_identifications read by govt in jurisdiction"
  ON public.pet_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.pets pt
      INNER JOIN public.govt_assignments ga ON ga.user_id = auth.uid()
      WHERE pt.id = pet_identifications.pet_id
        AND ga.revoked_at IS NULL
        AND ga.jurisdiction_province = pt.jurisdiction_province
    )
  );

-- No INSERT / UPDATE / DELETE policies — all writes go through server actions
-- via the BYPASSRLS service-role connection. Deny-all for PostgREST writes
-- is the correct safe default.

-- ===========================================================================
-- pet_transfers
-- ===========================================================================
-- Already has RLS enabled (migration 0086). Adding read policies.

-- The initiating owner (from_owner) can read their own sent transfers.
DROP POLICY IF EXISTS "pet_transfers read by sender" ON public.pet_transfers;
CREATE POLICY "pet_transfers read by sender"
  ON public.pet_transfers
  FOR SELECT
  TO authenticated
  USING (from_owner_id = auth.uid());

-- The receiving owner (to_owner) can read transfers offered to them.
-- This also covers the accept/reject flow where the recipient must be able
-- to read the offer before acting on it (action goes through server action).
DROP POLICY IF EXISTS "pet_transfers read by receiver" ON public.pet_transfers;
CREATE POLICY "pet_transfers read by receiver"
  ON public.pet_transfers
  FOR SELECT
  TO authenticated
  USING (to_owner_id = auth.uid());

-- Admin reads all transfers.
DROP POLICY IF EXISTS "pet_transfers read by admin" ON public.pet_transfers;
CREATE POLICY "pet_transfers read by admin"
  ON public.pet_transfers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
        AND p.deactivated_at IS NULL
    )
  );

-- No INSERT / UPDATE / DELETE policies — all writes go through server actions.

COMMIT;
