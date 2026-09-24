-- Migration 0230 — daily operator digest (T2-N1).
--
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
-- Two columns on `profiles`, nothing else. No new table: the digest is a mail
-- (transport, not a stored record) and its ONE piece of durable state — "did
-- this user already get today's digest" — fits on the recipient row itself.
--
--   daily_digest_opt_out       boolean, default false. /cuenta toggle
--                               (setDailyDigestOptOutAction). Institutional
--                               operators are subscribed by default; the mail
--                               only ever fires for a user who actually holds
--                               a pending queue (count > 0), so "opted in by
--                               default" never means "gets mail for nothing".
--
--   daily_digest_last_sent_on  date, nullable. The idempotency watermark.
--                               lib/infra/daily-operator-digest.ts claims a
--                               send with
--                                 UPDATE profiles
--                                 SET daily_digest_last_sent_on = $today
--                                 WHERE id = $userId
--                                   AND daily_digest_last_sent_on IS DISTINCT FROM $today
--                                 RETURNING id
--                               BEFORE composing the mail. Postgres's row lock
--                               on that UPDATE serializes two concurrent
--                               attempts for the SAME user for free (a retried
--                               dispatcher pass, or a manual re-run the same
--                               day) — no separate dedupe table, no dedupe key
--                               scheme to invent. $today is the Argentina
--                               calendar day (AR is a fixed -03:00, no DST —
--                               AGENTS.md's audit-filter precedent), computed
--                               in TypeScript, never `CURRENT_DATE` (that would
--                               be the DB server's own TZ, which is UTC in
--                               every environment here).
--
-- SUBJECT RIGHTS (Ley 25.326 arts. 14 + 16)
-- ---------------------------------------------------------------------------
-- No new table, so no new entry in scripts/check-subject-rights-coverage.ts's
-- CLASSIFICATION map. `profiles` is already `covered` on both sides there:
-- export_subject_data returns `row_to_json(p)` for the whole row (picks up a
-- new column automatically) and erase_subject_data operates on this same row.
-- Neither new column is itself sensitive — an opt-out flag and a date, not a
-- fact about the pet or a third party — and a deactivated/erased account is
-- excluded from the recipient query by the SAME predicates every other /gob
-- and /org read already uses (deactivated_at IS NULL, deleted_at IS NULL), so
-- an erased account cannot receive mail regardless of these two columns' value.

alter table public.profiles
  add column if not exists daily_digest_opt_out boolean not null default false,
  add column if not exists daily_digest_last_sent_on date;

comment on column public.profiles.daily_digest_opt_out is
  'Per-account opt-out from the daily operator digest email (T2-N1). Toggled from /cuenta.';
comment on column public.profiles.daily_digest_last_sent_on is
  'AR-calendar day (America/Argentina/Buenos_Aires) the digest was last sent to this user. Idempotency watermark — claimed via a conditional UPDATE before the mail is composed, not after it is sent.';
