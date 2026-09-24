-- DIM Tier 0+ emergency-info flag
-- -------------------------------
-- Adds pets.emergency_info_visible boolean. Owner-toggled "this pet takes
-- daily medication — contact me" banner on the public credential page.
-- UI preference; flipping it does NOT emit a pet_profile_updated event.
-- See AGENTS.md → Privacy tiers (Tier 0+).
--
-- Apply via Supabase Studio → SQL Editor. Idempotent — safe to re-run.
--
-- DO NOT apply via `pnpm db:push`. Push detects the welfare / organizations /
-- owner-facing RLS policies as drift (they live in db/*_rls.sql files, not in
-- Drizzle) and would propose dropping them. See engram gotcha
-- `gotchas/drizzle-rls-drift`.

alter table "public"."pets"
  add column if not exists "emergency_info_visible" boolean not null default false;
