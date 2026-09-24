-- Migration 0236 — `pets` has NO update surface through PostgREST.
--
-- THE HOLE (T3-F1, found by the RLS matrix's first write run, 2026-09-22)
-- ---------------------------------------------------------------------------
-- "Pets updatable by active owner" (0086, re-scoped by 0190 onto
-- has_titular_write_access) decides WHICH ROWS a caller may update — their own
-- pet, as its titular — and says nothing about WHICH COLUMNS. `authenticated`
-- holds UPDATE on every one of the 77 columns of `pets` (Supabase's default
-- grants, re-applied by scripts/deploy-provision.ts applySchemaGrants on every
-- provision). So one request signed with the owner's own JWT —
--
--   PATCH /rest/v1/pets?id=eq.<own pet>  {"rabies_observation_status": null}
--
-- — rewrote a column the product reads as a fact nobody but the server may
-- state. Measured through PostgREST before this migration, the owner could
-- rewrite, on their own pet:
--
--   · status, deceased_at            — lifecycle facts, event-sourced
--                                       (invariant #3): a lost or dead animal
--                                       made "active" again without an event;
--   · rabies_observation_status      — a public-health observation, cleared
--                                       by the person it was imposed on;
--   · in_custody_dispute             — the flag that freezes a disputed pet,
--                                       lifted by one of the disputing parties;
--   · public_token                   — the credential itself (invariant #1),
--                                       re-pointed or collided;
--   · deleted_at                     — a soft delete that bypasses the audit
--                                       and retention path;
--   · jurisdiction_locality          — which authority sees the animal, moved
--                                       out of a govt operator's scope;
--   · adoption_eligible              — the adoption gate a shelter decision
--                                       sets.
--
-- Those eight are the ones the matrix probes (__tests__/rls/matrix.test.ts,
-- PETS_OWNER_FORBIDDEN_COLUMNS); the grant covered all 77. It is the same
-- class 0211 closed on `profiles` (a user setting their own role) and 0212 on
-- `pet_events` (an owner signing as govt): a correctly row-scoped policy that
-- is column-blind.
--
-- WHY DENY-ALL AND NOT A COLUMN LIST
-- ---------------------------------------------------------------------------
-- Zero legitimate writers reach `pets` through PostgREST. Every pet edit is
-- `db.update(pets)` / `tx.update(pets)` over the Drizzle connection, which is
-- BYPASSRLS and never consults a policy or a grant; apps/mobile writes only
-- through /api/v1, which is that same server path. `rg 'from("pets")'` over
-- app/, lib/, src/ and apps/ finds no caller, and the only PostgREST callers of
-- this table anywhere are SELECT probes (scripts/rls-smoke.ts, the RLS matrix,
-- e2e/cross-tenant-isolation.spec.ts). A column allowlist would be a policy
-- admitting a path nobody uses. The one database function that updates pets,
-- erase_subject_data, is SECURITY DEFINER and runs as its owner.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
--   1. DROP POLICY "Pets updatable by active owner". With RLS enabled and no
--      UPDATE policy, every caller-issued UPDATE matches zero rows. THIS is
--      the boundary.
--   2. REVOKE UPDATE ON public.pets FROM anon, authenticated — defence in
--      depth, so a caller gets 42501 instead of a silent 0 rows. It is NOT the
--      boundary, on purpose: scripts/deploy-provision.ts applySchemaGrants
--      re-grants ALL on every table on each provision, so on an environment
--      provisioned after this file the grant comes back. The policy's absence
--      does not come back, and the assertion below checks the policy, not the
--      grant.
--
-- has_titular_write_access (0190) STAYS: it still backs the
-- libreta_share_tokens INSERT policy.
--
-- READS ARE UNTOUCHED. "Pets readable by active owner" stays, so the table
-- keeps a policy and check-rls-coverage.ts stays green without an allowlist.
--
-- Forward-only and idempotent: DROP POLICY IF EXISTS and REVOKE are no-ops on
-- re-run, and the post-condition block is satisfied by the state they leave.
-- Mirrored into db/rls.sql (reference copy) in the same commit.

DROP POLICY IF EXISTS "Pets updatable by active owner" ON public.pets;

REVOKE UPDATE ON public.pets FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post-condition fence, name-independent (0212's lesson: a DROP POLICY by NAME
-- reports success and does nothing when the environment was hand-patched and
-- the policy carries another name). It asks the catalog whether ANY
-- caller-reachable UPDATE policy survives on pets, whatever it is called.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s (%s, %s)', p.policyname, p.cmd, array_to_string(p.roles, '/')), '; ')
    INTO offenders
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'pets'
    AND p.cmd IN ('UPDATE', 'ALL')
    AND p.roles && ARRAY['anon', 'authenticated', 'public']::name[];

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0236 did not close: pets still carries a caller-reachable UPDATE policy (%). Inventory pg_policies for pets and drop the surviving policy by its real name before retrying.',
      offenders;
  END IF;

  -- The inverse mistake: the read surface must survive.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pets' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'Migration 0236 over-corrected: pets has no SELECT policy left. Owners must keep reading their own pets, and check-rls-coverage.ts requires at least one policy on this table.';
  END IF;
END
$$;
