-- Schema prerequisites — everything `drizzle-kit push` needs to ALREADY EXIST.
--
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------
-- db/schema.ts declares generated columns whose expressions call SQL functions.
-- drizzle-kit push emits those columns as part of CREATE TABLE, so the function
-- has to exist BEFORE push runs. It does not, on a database that has never been
-- bootstrapped: the function is born in a migration, and the migration tree is
-- replayed AFTER push.
--
-- That is an egg-and-chicken with real consequences, measured 2026-07-27 on a
-- virgin Postgres:
--
--   * push fails partway with "function public.immutable_unaccent(text) does
--     not exist" — and STILL EXITS 0, creating 4 of the 52 declared tables;
--   * the migration replay cannot recover, because db/migrations/0000 onward
--     contains no CREATE TABLE at all — push is the sole creator of tables.
--     The replay reports 159/159 "exit-zero" while every statement inside it
--     errors with "relation public.pets does not exist";
--   * the bootstrap finishes with 15 of 52 tables and no complaint.
--
-- It stayed invisible because CI had not run since 2026-06-12 and no
-- long-lived local stack is ever virgin. The first CI run after the workflow
-- was re-enabled failed here, in three jobs at once.
--
-- CONTRACT
-- ---------------------------------------------------------------------------
-- Applied by scripts/db-bootstrap.ts as step 0, before db:push. Strictly
-- idempotent (IF NOT EXISTS / CREATE OR REPLACE), so it is safe on a database
-- that already has everything.
--
-- This file is NOT a migration and must never become one. The migration tree
-- stays authoritative for deployed databases — migration 0146 creates the same
-- function with the same body, and replaying it over this one is a no-op. Keep
-- the two in sync: if 0146's definition ever changes, change it here too, and
-- say so in the migration that changes it.
--
-- Add to this file only what push itself cannot proceed without.

-- gen_random_uuid() and friends, used by column defaults.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- unaccent() — installed into public so the dictionary can be named explicitly
-- as 'public.unaccent'::regdictionary below.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- IMMUTABLE unaccent wrapper — pins the dictionary explicitly so the generated
-- column expression is provably immutable and independent of search_path.
-- Mirrors db/migrations/0146_ar_localities_locality_name_norm.sql exactly.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $func$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $func$;
