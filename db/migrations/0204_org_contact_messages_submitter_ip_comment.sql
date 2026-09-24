-- Migration 0204 — correct a FALSE column comment on org_contact_messages.submitter_ip.
--
-- WHAT WAS WRONG
-- --------------
-- 0051_org_contact_messages.sql:30 wrote, and the database still carries:
--
--   'First IP from X-Forwarded-For — used by the rate_limit_buckets cohort key,
--    not for analytics.'
--
-- The "First IP from X-Forwarded-For" half was never true of the code. The value
-- is produced by callerIp() (lib/infra/rate-limit.ts), reached through
-- callerIpAddress() in src/modules/organizations/actions.ts. It reads `x-real-ip`
-- first — the header Vercel's edge rewrites, so on a deployed origin that is the
-- only source that ever answers — and falls back to walking `x-forwarded-for`
-- from the RIGHT, taking the LAST non-empty hop. The first segment is not read on
-- any path.
--
-- WHY THIS IS WORTH A MIGRATION OF ITS OWN
-- ----------------------------------------
-- Not for tidiness. The FIRST segment of X-Forwarded-For is the one this codebase
-- documents everywhere else as CLIENT-SUPPLIED and freely spoofable; callerIp's
-- own comment says "DO NOT take the first segment either way". A future change
-- that aligned the code to this comment — a reasonable-looking reconciliation of
-- a schema comment with its implementation — would key an abuse limiter on the
-- exact segment an abuser controls, and would read in review as removing an
-- inconsistency rather than removing a control. A false comment about a security
-- boundary is a trap left for a future maintainer, not a typo.
--
-- WHY THE 0051 FILE IS NOT EDITED
-- -------------------------------
-- Migrations here are forward-only and immutable: 0051 is applied, and rewriting
-- an applied file makes the record disagree with what the databases actually ran.
-- A COMMENT is a live database object, so unlike a false premise stranded in a
-- migration HEADER (see the ERRATA at the top of
-- src/modules/auth/application/subject-rights/erase-subject-data.ts, which could
-- only be answered in prose at the code site) this one CAN be corrected forward,
-- in the place that carries it. db/schema.ts carries the same correction for
-- whoever reads the Drizzle definition instead of the database.
--
-- Comment-only. No DDL, no data change, no lock beyond the catalog row. Safe to
-- apply at any time, and harmless if it is never applied — the code does not read
-- comments. That is also why nothing gates on it.

BEGIN;

COMMENT ON COLUMN org_contact_messages.submitter_ip IS
  'Caller IP for the rate_limit_buckets cohort key, not for analytics. Produced by callerIp() (lib/infra/rate-limit.ts): x-real-ip if present, else the LAST hop of x-forwarded-for. Never the first XFF segment — that one is client-supplied and spoofable. Supersedes the comment written by migration 0051, which said "First IP from X-Forwarded-For" and was never true of the code.';

COMMIT;
