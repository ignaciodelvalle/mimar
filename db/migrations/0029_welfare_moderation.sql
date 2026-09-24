-- Welfare moderation layer — auto-flagging of suspicious anonymous denuncias
-- before they reach the govt triage queue at /gob/maltrato.
--
-- A row is "flagged" when `flagged_at` is set and `moderation_resolved_at`
-- is null. The govt queue filters those out by default; admin sees them at
-- /admin/moderacion and either passes them to triage (unflag) or confirms
-- as spam (status='invalid').
--
-- `flag_reasons` is a jsonb array of stable string codes computed by
-- `lib/welfare-moderation.ts`. Storing as jsonb (not text[]) so future
-- evolutions can attach payload to a reason without a migration.
--
-- Idempotent — safe to re-run.

alter table public.welfare_reports
  add column if not exists flagged_at timestamptz;

alter table public.welfare_reports
  add column if not exists flag_reasons jsonb not null default '[]'::jsonb;

alter table public.welfare_reports
  add column if not exists moderation_resolved_at timestamptz;

alter table public.welfare_reports
  add column if not exists moderation_resolved_by_user_id uuid
  references public.profiles(id) on delete set null;

-- Index for the moderation queue — only flagged + unresolved rows.
create index if not exists welfare_reports_flagged_idx
  on public.welfare_reports (flagged_at)
  where flagged_at is not null and moderation_resolved_at is null;
