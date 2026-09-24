-- Migration 0190 — give the titular-only deny-list an RLS counterpart.
--
-- THE HOLE (custodia-temporal RLS audit, 2026-08-19)
-- ---------------------------------------------------------------------------
-- Every ownership-derived policy in this database tests
-- `owner_user_id = auth.uid() AND ended_at IS NULL` with NO role predicate.
-- Migration 0163's own header says it, about co_owner: "every downstream policy
-- — pets SELECT/UPDATE, pet_events SELECT/INSERT, attachments — tests for an
-- ownership row with NO role filter." It is equally true of `caretaker`, and
-- from migration 0189 caretaker rows are a thing that exists.
--
-- Consequence, measured rather than assumed: an active caretaker holding a
-- valid Supabase bearer token could talk to PostgREST directly and
--   PATCH /rest/v1/pets                 {"jurisdiction_province": …}   → deny-list row 3
--   PATCH /rest/v1/pets                 {"tier2_public_enabled_until": …} → row 5
--   PATCH /rest/v1/pets                 {"name": …}                    → row 7
--   POST  /rest/v1/pet_events           {"event_type":"custody_transferred"} → row 1
--   POST  /rest/v1/libreta_share_tokens {…}                            → row 6
-- without the Next.js app — and therefore without requireTitularAccess or
-- scripts/check-titular-gate.ts — ever running. The app-layer deny-list is real
-- against the app and worth nothing against a bearer token.
--
-- The worst of those is the forged `custody_transferred`: pet_events has no
-- UPDATE and no DELETE policy and invariant #2 forbids deletion, so it would be
-- a PERMANENT entry in the append-only spine. The transfers module would not
-- honour it (ownerships has had no write policy since 0163), which makes it a
-- lie in the ledger rather than a theft of the animal — but a permanent lie in
-- an append-only ledger is precisely what invariant #2 exists to prevent.
--
-- That PostgREST is reachable by an authenticated attacker is not speculation:
-- 0163 exists because somebody exercised that exact vector (RA-8 finding R1).
--
-- THE FORK, AND WHY THIS BRANCH
-- ---------------------------------------------------------------------------
-- (A) Role-filter the three policies for every non-owner role. Cheap to write,
--     but it rewrites policies serving every holder on a live system and
--     re-opens "should a foster publish a pet for adoption?" — a bigger product
--     question this change must not smuggle in.
-- (B) Keep the existing ownership predicate and AND a narrow, caretaker-shaped
--     denial behind one named SECURITY DEFINER helper, mirroring the
--     can_read_case convention already in this codebase.
--
-- (B). It is provably a no-op on current data — `SELECT count(*) FROM ownerships
-- WHERE role='caretaker'` returns 0, verified before writing — it does not
-- re-litigate foster, and it puts the predicate in ONE function body instead of
-- N policies, so a future role decision is one edit.
--
-- READS ARE DELIBERATELY UNTOUCHED. A caretaker SHOULD read the pet and the
-- spine; that is the arrangement. Only writes narrow.
--
-- WHAT THIS DOES NOT COVER, STATED RATHER THAN GLOSSED
-- ---------------------------------------------------------------------------
-- Transfer INITIATION, adoption publishing, pet deletion and caretaker
-- sub-designation are multi-step orchestrations — no single PostgREST call
-- performs them, so there is no policy to hang a predicate on. The app-layer
-- guard is the only meaningful gate there and it is sufficient. RLS here is a
-- SECOND, UNCORRELATED layer, not a total one. The argument for having both is
-- exactly that their failure modes do not overlap: a regex fence loses to an
-- event type built from a variable, and RLS loses to an orchestration.
--
-- THE HONEST COST
-- ---------------------------------------------------------------------------
-- `titular_only_event_types()` is a SECOND COPY of the TS constant in
-- lib/domain/titular-only.ts. Duplication is the price of defense in depth, and
-- it is only acceptable because it is fenced: __tests__/caretaker-rls-hardening
-- .test.ts asserts the SQL array equals the TS array and goes red the moment
-- either side moves alone.

-- ---------------------------------------------------------------------------
-- Helper 1 — the role predicate, in one place.
-- ---------------------------------------------------------------------------
-- TRUE when the user holds an active NON-caretaker ownership row on the pet.
-- SECURITY DEFINER because it reads `ownerships`, which the calling role may
-- not read in full; STABLE because it is a read inside one statement; empty
-- search_path because a SECURITY DEFINER function with a mutable search_path is
-- a privilege-escalation primitive.
CREATE OR REPLACE FUNCTION public.has_titular_write_access(p_pet_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ownerships o
    WHERE o.pet_id = p_pet_id
      AND o.owner_user_id = p_user_id
      AND o.ended_at IS NULL
      AND o.role <> 'caretaker'
  );
$$;

COMMENT ON FUNCTION public.has_titular_write_access(uuid, uuid) IS
  'True when the user holds an active NON-caretaker ownership row on the pet. The role predicate behind the titular-only RLS clauses (custodia-temporal, 0190). Deliberately a DENY of caretaker rather than an allow-list of roles: co_owner, foster and shelter_custody keep exactly the access they had.';

-- ---------------------------------------------------------------------------
-- Helper 2 — the SQL mirror of TITULAR_ONLY_EVENT_TYPES.
-- ---------------------------------------------------------------------------
-- Keep in sync with lib/domain/titular-only.ts. A db-project test asserts the
-- equality, so a drift here is a red build, not a silent divergence.
-- IMMUTABLE: it is a literal.
CREATE OR REPLACE FUNCTION public.titular_only_event_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT ARRAY[
    'custody_transfer_proposed',
    'custody_transferred',
    'custody_transfer_cancelled',
    'adoption_eligibility_set'
  ]::text[];
$$;

COMMENT ON FUNCTION public.titular_only_event_types() IS
  'SQL mirror of TITULAR_ONLY_EVENT_TYPES in lib/domain/titular-only.ts. Second copy on purpose (defense in depth); the duplication is fenced by an equality test in the db vitest project.';

-- ---------------------------------------------------------------------------
-- Policy 1 — pets UPDATE. USING and WITH CHECK both, symmetric.
-- ---------------------------------------------------------------------------
-- Covers jurisdiction (row 3), the Tier-2 window and the disclose flags (row 5)
-- and the identity fields (row 7) in one clause, because they are all columns
-- on the same row and RLS is row-level, not column-level.
DROP POLICY IF EXISTS "Pets updatable by active owner" ON public.pets;

CREATE POLICY "Pets updatable by active owner" ON public.pets
  FOR UPDATE TO authenticated
  USING (public.has_titular_write_access(id, (SELECT auth.uid())))
  WITH CHECK (public.has_titular_write_access(id, (SELECT auth.uid())));

-- ---------------------------------------------------------------------------
-- Policy 2 — pet_events INSERT. NOT a blanket deny.
-- ---------------------------------------------------------------------------
-- A caretaker MUST be able to insert medical events; that is the arrangement.
-- So the clause is event-type-shaped: the ownership predicate is unchanged, and
-- only a titular-only event_type additionally demands titular write access.
DROP POLICY IF EXISTS "Pet events insertable by active owner (owner-self only)" ON public.pet_events;

CREATE POLICY "Pet events insertable by active owner (owner-self only)" ON public.pet_events
  FOR INSERT TO authenticated
  WITH CHECK (
    author_organization_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.ownerships o
      WHERE o.pet_id = pet_events.pet_id
        AND o.owner_user_id = (SELECT auth.uid())
        AND o.ended_at IS NULL
    )
    AND (
      NOT (event_type = ANY (public.titular_only_event_types()))
      OR public.has_titular_write_access(pet_events.pet_id, (SELECT auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- Policy 3 — libreta_share_tokens INSERT (deny-list row 6).
-- ---------------------------------------------------------------------------
-- A libreta share is a bearer-readable public link to the animal's medical
-- record. Minting one is a disclosure decision, and a disclosure decision
-- belongs to the titular.
DROP POLICY IF EXISTS "owner can insert libreta shares for their pets" ON public.libreta_share_tokens;

CREATE POLICY "owner can insert libreta shares for their pets" ON public.libreta_share_tokens
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by_user_id = (SELECT auth.uid())
    AND pet_id IN (
      SELECT o.pet_id
      FROM public.ownerships o
      WHERE o.owner_user_id = (SELECT auth.uid())
        AND o.ended_at IS NULL
    )
    AND public.has_titular_write_access(pet_id, (SELECT auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
-- A DROP POLICY by NAME reports success and does nothing at all when the target
-- environment was hand-patched and the policy carries a different name. Staging
-- and prod are not known to match this file's assumptions, so the migration
-- refuses to report success unless all three policies exist AND actually carry
-- the new predicate. Without this, the most likely failure mode is a green
-- deploy over an unchanged policy set.
-- NOTE on the `::text` casts below, learned the hard way while writing this
-- file: `text[] || 'literal'` makes Postgres parse the literal AS AN ARRAY and
-- fail with "malformed array literal". The first version of this block had no
-- casts, and the migration still applied CLEANLY — because every IF was false,
-- so the broken line never executed. A post-condition fence that only runs on
-- the failure path has to be exercised on that path before you believe it.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pets'
      AND policyname = 'Pets updatable by active owner'
      AND qual LIKE '%has_titular_write_access%'
      AND with_check LIKE '%has_titular_write_access%'
  ) THEN
    missing := missing || 'pets UPDATE'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pet_events'
      AND policyname = 'Pet events insertable by active owner (owner-self only)'
      AND with_check LIKE '%titular_only_event_types%'
  ) THEN
    missing := missing || 'pet_events INSERT'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'libreta_share_tokens'
      AND policyname = 'owner can insert libreta shares for their pets'
      AND with_check LIKE '%has_titular_write_access%'
  ) THEN
    missing := missing || 'libreta_share_tokens INSERT'::text;
  END IF;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      'Migration 0190 did not close: % still lack the titular predicate. The environment probably carries hand-patched policy names — inventory pg_policies before retrying.',
      array_to_string(missing, ', ');
  END IF;
END
$$;
