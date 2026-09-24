-- Migration 0217 — restore three owner-facing policies that baselining skipped.
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- The staging database was BASELINED: at some point its `_dim_migrations` rows
-- were written without the migrations behind them having run. Every migration
-- reads as applied, so `pnpm db:migrate` has nothing to say, and `pnpm db:drift`
-- is silent too — that script compares TABLES, COLUMNS, CONSTRAINTS and INDEXES,
-- and is completely blind to row-level security policies. Neither tool can see
-- this class of drift. It surfaced only on 2026-09-10, when migration 0215
-- aborted on staging with
--
--     policy "pet_identifications read by admin" does not exist
--
-- A policy-by-policy comparison of the two catalogs (pg_policies, schema
-- `public`) was then taken by hand. Exactly four policies existed locally and
-- not on staging:
--
--     attachments          "Attachments insertable by pet owner"       (0086)
--     attachments          "Attachments updatable by pet owner"        (0086)
--     pet_identifications  "pet_identifications read by active owner"  (0105)
--     pet_identifications  "pet_identifications read by admin"         (0105)
--
-- The fourth is NOT repaired here: migration 0215 was amended the same day to
-- create it with DROP POLICY IF EXISTS + CREATE POLICY instead of bare-ALTERing
-- it, so 0215 restores it on the way past. This migration repairs the other
-- three, which no other migration touches.
--
-- WHAT THIS COSTS WHILE IT IS MISSING
-- ---------------------------------------------------------------------------
-- `attachments` has RLS enabled, so a missing INSERT policy is not an opening —
-- it is a CLOSURE. On staging an owner cannot attach a photo or a document to
-- their own pet through PostgREST at all, and cannot update one they already
-- own. That is a functional hole, not a security hole, and it fails closed.
--
-- The two `pet_identifications` SELECT policies are the same shape: a pet owner
-- could not read their own animal's chip or tattoo records on staging.
--
-- The direction is worth stating plainly because it decides the urgency. None
-- of the four grants anything to a stranger; all four grant an owner or an
-- administrator access to rows they are entitled to. Baselining dropped
-- capability, not protection.
--
-- WHERE THE BODIES COME FROM
-- ---------------------------------------------------------------------------
-- NOT from the migration that first created them. 0086 created the two
-- `attachments` policies with a bare `auth.uid()`; migration 0137 later rewrote
-- every policy in the database into the `( SELECT auth.uid() )` initplan form so
-- Postgres evaluates the call once per statement instead of once per row.
-- Transcribing 0086 would therefore have restored a slower, older body and
-- reintroduced the drift 0137 removed.
--
-- The clauses below were transcribed from the LIVE local catalog
-- (`select qual, with_check from pg_policies`) on 2026-09-10 — that is, from
-- what actually runs after all 216 migrations, which is exactly the state
-- staging is supposed to converge to. `db/rls.sql` was not used either: the
-- bootstrap files still carry the pre-0137 bare form.
--
-- SHAPE
-- ---------------------------------------------------------------------------
-- DROP POLICY IF EXISTS + CREATE POLICY throughout. Never a bare ALTER — that
-- is the exact mistake that made 0215 abort, and the lesson generalises: a
-- migration must not ALTER an object it did not create, because it cannot know
-- the object is there. Written this way the migration is idempotent and safe on
-- every environment, including the local database where all three already
-- exist and will simply be replaced by identical bodies.
--
-- AFTERWARDS
-- ---------------------------------------------------------------------------
-- Run `npx tsx scripts/check-rls-coverage.ts` against the repaired database.
-- Its live half reads pg_policies directly and is the only instrument in the
-- repo that can see this drift at all.

BEGIN;

-- ---------------------------------------------------------------------------
-- attachments — the owner of the pet may attach, and may amend their own
-- attachment. The event branch covers an attachment hung off a pet_event
-- rather than directly off the pet.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Attachments insertable by pet owner" ON public.attachments;
CREATE POLICY "Attachments insertable by pet owner"
  ON public.attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.ownerships o
      WHERE o.owner_user_id = (select auth.uid())
        AND o.ended_at IS NULL
        AND (
          o.pet_id = attachments.pet_id
          OR o.pet_id = (
            SELECT pe.pet_id
            FROM public.pet_events pe
            WHERE pe.id = attachments.event_id
          )
        )
    )
  );

DROP POLICY IF EXISTS "Attachments updatable by pet owner" ON public.attachments;
CREATE POLICY "Attachments updatable by pet owner"
  ON public.attachments
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.ownerships o
      WHERE o.owner_user_id = (select auth.uid())
        AND o.ended_at IS NULL
        AND (
          o.pet_id = attachments.pet_id
          OR o.pet_id = (
            SELECT pe.pet_id
            FROM public.pet_events pe
            WHERE pe.id = attachments.event_id
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- pet_identifications — the current owner reads their own animal's chip and
-- tattoo records. `ended_at IS NULL` is what makes it the CURRENT owner: a
-- previous owner's ownership row is closed, not deleted, so this policy stops
-- granting the moment the animal changes hands.
--
-- The admin-side twin, "pet_identifications read by admin", is created by
-- migration 0215 and deliberately left alone here.
-- ---------------------------------------------------------------------------

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
        AND o.owner_user_id = (select auth.uid())
        AND o.ended_at IS NULL
    )
  );

COMMIT;
