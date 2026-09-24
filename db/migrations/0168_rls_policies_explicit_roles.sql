-- Migration 0168 — give every RLS policy an explicit TO clause.
--
-- WHAT WAS FOUND (local DB at migration HEAD, 2026-08-05)
-- ------------------------------------------------------------------------
-- 80 policies live in the public schema. 65 name `authenticated`, 5 name
-- `anon, authenticated` — and 10 name nobody at all:
--
--   ar_localities              "ar_localities select authenticated"
--   ar_localities_import_runs  "ar_localities_import_runs select admin"
--   cases                      "cases_select_visible"
--   cron_runs                  "cron_runs select by admin"
--   custody_dispute_parties    "custody_dispute_parties select by parties and authorities"
--   custody_disputes           "custody_disputes select by parties and authorities"
--   pet_achievement_views      "achievement_views insert by owner"
--   pet_achievement_views      "achievement_views select by owner"
--   pet_achievement_views      "achievement_views update by owner"
--   pet_service_dog            "service_dog select by owner or authority"
--
-- A CREATE POLICY with no TO clause defaults to PUBLIC, which in Postgres means
-- EVERY role — `anon` included. `anon` is the key that ships in the client
-- bundle. So ten policies covering custody disputes, cases, service-dog
-- registrations and locality reference data are, on paper, offered to the
-- unauthenticated public.
--
-- WHY NOTHING LEAKED (and why that is not a reason to leave it)
-- ------------------------------------------------------------------------
-- All ten are saved by their PREDICATE, not by their role set. Every one of
-- them resolves through `(select auth.uid())`: `ar_localities` requires it to
-- be NOT NULL; the other nine join it against profiles / ownerships /
-- organization_memberships / govt_assignments. For `anon`, auth.uid() is NULL,
-- so each predicate is false or empty and no row is returned.
--
-- That is defense by accident. The role set is the FIRST gate and it is wide
-- open; the only thing holding is the second. Any future edit that relaxes a
-- predicate — a new OR branch, a NULL-tolerant join, a "public reference data"
-- carve-out written without noticing the missing TO — turns an authorization
-- bug into an anonymous read of the whole table. Two of these tables
-- (custody_disputes, custody_dispute_parties) carry exactly the kind of
-- personal dispute data that has no business one predicate away from `anon`.
--
-- WHAT THIS DOES
-- ------------------------------------------------------------------------
-- Narrows all ten to `TO authenticated` — the NARROWEST role set that preserves
-- today's behavior exactly, because every one of these policies already refuses
-- a caller without a session. `ar_localities` is reference data and might look
-- like a candidate for `anon`, but its own predicate is
-- `(select auth.uid()) IS NOT NULL`: it has always been authenticated-only, and
-- this migration changes nothing about that.
--
-- The app is unaffected either way — db/index.ts connects with postgres-js as a
-- BYPASSRLS role and never consults a policy. This is entirely about what
-- PostgREST hands to a key-holder.
--
-- SAFETY
-- ------------------------------------------------------------------------
-- Forward-only. ALTER POLICY ... TO replaces only the role set; USING and
-- WITH CHECK are untouched (same surgical shape as 0137, which replaced only
-- the expressions). Every policy listed exists on any database replayed to this
-- point. Re-issuing the same role set is naturally idempotent, and the runner
-- tracks applied files by checksum, so this never re-runs. Transaction-safe.
--
-- The fence that should have caught this — lint:rls — is widened in the same
-- change: it now requires an explicit, non-PUBLIC role set on every policy, so
-- the eleventh policy cannot land the way these ten did.

BEGIN;

ALTER POLICY "ar_localities select authenticated" ON public."ar_localities"
  TO authenticated;

ALTER POLICY "ar_localities_import_runs select admin" ON public."ar_localities_import_runs"
  TO authenticated;

ALTER POLICY "cases_select_visible" ON public."cases"
  TO authenticated;

ALTER POLICY "cron_runs select by admin" ON public."cron_runs"
  TO authenticated;

ALTER POLICY "custody_dispute_parties select by parties and authorities" ON public."custody_dispute_parties"
  TO authenticated;

ALTER POLICY "custody_disputes select by parties and authorities" ON public."custody_disputes"
  TO authenticated;

ALTER POLICY "achievement_views insert by owner" ON public."pet_achievement_views"
  TO authenticated;

ALTER POLICY "achievement_views select by owner" ON public."pet_achievement_views"
  TO authenticated;

ALTER POLICY "achievement_views update by owner" ON public."pet_achievement_views"
  TO authenticated;

ALTER POLICY "service_dog select by owner or authority" ON public."pet_service_dog"
  TO authenticated;

COMMIT;
