-- DIM post-adoption check-in reminder type — schema migration
-- ------------------------------------------------------------
-- Adds a new value to the `reminder_type` enum so the adoption-finalize flow
-- can insert reminder rows for the 1m/3m/6m/12m post-adoption check-in
-- windows defined in AGENTS.md → Custody & adoption. The cron job in
-- app/api/cron/post-adoption-checkin/route.ts scans these reminders.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor.
-- Idempotent — safe to re-run.
--
-- DO NOT apply this via `pnpm db:push`. Push detects existing welfare_reports
-- RLS policies as drift (they live in db/welfare_rls.sql, not in db/schema.ts)
-- and proposes to DROP them. See engram gotcha `gotchas/drizzle-rls-drift`.

-- Postgres `alter type ... add value if not exists` is the canonical
-- idempotent enum-extension form. Each new value gets appended at the end of
-- the enum's ordering; downstream selects don't care about ordering.
alter type "public"."reminder_type" add value if not exists 'post_adoption_checkin';
