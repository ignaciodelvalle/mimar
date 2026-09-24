-- Admin page Fase 14 — cron_runs telemetry table.
--
-- One row per cron invocation, written by the route handler. Status
-- transitions running → ok|failed. Surfaces in /admin/sistema.
--
-- RLS: admin-only SELECT. INSERT/UPDATE go through the service-role
-- connection (Drizzle direct) which bypasses RLS.

create table if not exists "public"."cron_runs" (
  "id"              uuid primary key default gen_random_uuid(),
  "cron_name"       text not null,
  "started_at"      timestamptz not null default now(),
  "finished_at"     timestamptz,
  "status"          text not null default 'running',
  "items_processed" integer not null default 0,
  "details"         jsonb not null default '{}'::jsonb,

  constraint cron_runs_status_valid check (status in ('running','ok','failed'))
);

create index if not exists "cron_runs_name_started_idx"
  on "public"."cron_runs" ("cron_name", "started_at" desc);

alter table "public"."cron_runs" enable row level security;

drop policy if exists "cron_runs select by admin" on "public"."cron_runs";
create policy "cron_runs select by admin"
  on "public"."cron_runs" for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );
