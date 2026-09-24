-- Migration 0165 — enable RLS on every table where a migration already claimed to.
-- (Measured on DIM-staging, 2026-07-31.)
--
-- WHAT WAS FOUND
-- --------------
-- `_dim_migrations` on staging listed 156 applied migrations, through 0157.
-- Among them is 0086, whose line 109 reads:
--
--   alter table public.ownerships enable row level security;
--
-- On staging, `pg_class.relrowsecurity` for `ownerships` was FALSE, and the
-- table carried zero policies. Twenty-seven of the fifty-three public tables
-- were in that state, including profiles, pets, pet_identifications,
-- notifications, audit_log, attachments and libreta_share_tokens. Every one of
-- them granted SELECT to `anon`; `ownerships` also granted INSERT, UPDATE and
-- DELETE. The anon key ships in the client bundle, so PostgREST served that
-- surface to anyone holding a public key — the exact threat model this project
-- already writes down.
--
-- Production was clean: RLS on all 53 tables, zero exceptions. This is an
-- environment defect, not a code defect.
--
-- WHY THE LEDGER SAID OTHERWISE
-- -----------------------------
-- Most likely `drizzle-kit push` (which builds tables from db/schema.ts, and
-- schema.ts carries no RLS) followed by `migrate.ts --baseline`, which marks
-- every file applied and runs no SQL. That combination yields exactly what was
-- measured: correct tables, correct columns, no RLS, and a ledger that reports
-- a clean bill of health. Three tables — attachments, pet_events,
-- pet_identifications — even had one policy each, inert, because a policy
-- without RLS enabled does nothing at all.
--
-- WHY A MIGRATION AND NOT A ONE-OFF SCRIPT
-- ----------------------------------------
-- Because `db:migrate` will never re-run 0086: the ledger says it is done. Any
-- environment built the same way is silently exposed and the tooling reports
-- success. A new migration is the only form that reaches those environments
-- through the normal path, and it is a no-op on any environment that is already
-- correct — ALTER TABLE ... ENABLE ROW LEVEL SECURITY does nothing when RLS is
-- already on. Production applies this and changes nothing.
--
-- SAFETY
-- ------
-- Nothing in the application reads a table through the anon or authenticated
-- Supabase client — verified by sweep: the Supabase client is used for auth and
-- storage only, and every table read goes through Drizzle on DATABASE_URL as
-- the table owner, which is not subject to RLS. Production has run with RLS on
-- all 53 of these tables since it was provisioned. Enabling it here removes the
-- PostgREST surface and touches no application path.
--
-- NOT IN THIS MIGRATION: the backstop POLICIES that 0086 and its siblings
-- create are still missing on the affected environment. That is deliberate.
-- Enabling RLS with no policies denies more, not less, and nothing depends on
-- those policies today. Bringing policy sets to parity is a separate change
-- that must be reviewed clause by clause — a wrong policy re-opens what this
-- migration closes.

alter table public.alert_firings enable row level security;
alter table public.alert_subscriptions enable row level security;
alter table public.approval_requests enable row level security;
alter table public.ar_localities enable row level security;
alter table public.ar_localities_import_runs enable row level security;
alter table public.attachments enable row level security;
alter table public.audit_log enable row level security;
alter table public.case_events enable row level security;
alter table public.eno_processing_queue enable row level security;
alter table public.event_notification_outbox enable row level security;
alter table public.govt_assignments enable row level security;
alter table public.govt_business_rules enable row level security;
alter table public.jurisdictions_census enable row level security;
alter table public.libreta_share_tokens enable row level security;
alter table public.notification_dead_letter enable row level security;
alter table public.notifications enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.ownerships enable row level security;
alter table public.pet_events enable row level security;
alter table public.pet_identifications enable row level security;
alter table public.pet_transfers enable row level security;
alter table public.pets enable row level security;
alter table public.physical_tag_interest enable row level security;
alter table public.profiles enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.reminders enable row level security;
alter table public.share_telemetry enable row level security;
