-- 0136 — DB-side reaper for stuck application backends (pg_cron).
--
-- WHY (measured on staging, 2026-07-09/10): the app's client-side db budgets
-- (withDbBudget, 8-20s) ABANDON a slow query but cannot cancel it — and the
-- statement_timeout startup GUC is not applied by supavisor's TRANSACTION
-- pooler (documented in db/index.ts), so the query keeps running server-side.
-- Abandoned backends accumulate (observed: a query stuck 165s on a 3-row
-- table, another 72s in wait_event=ClientRead with its resultset never read)
-- until the micro instance starves and every dashboard blows its budget —
-- the task #74 "death spiral". Manual pg_terminate_backend relieved it three
-- times in one day; this migration automates exactly that relief.
--
-- SCOPE: ONLY backends whose application_name = 'Supavisor' (the app's pooled
-- connections). Direct connections (migrations, seeds, dashboards, PostgREST,
-- supabase internals) carry a different application_name and are never touched.
-- Thresholds sit far above the app's own budgets (max 20s), so no legitimate
-- app query can be reaped.
--
-- PO-authorized 2026-07-10 (explicit, beyond the CREATE-INDEX-only default).

create extension if not exists pg_cron;

create or replace function public.reap_stuck_app_backends()
returns integer
language sql
security definer
set search_path = ''
as $$
  select count(*)::int from (
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where backend_type = 'client backend'
      and application_name = 'Supavisor'
      and pid <> pg_backend_pid()
      and (
        -- runaway query: still executing long past every app budget
        (state = 'active' and wait_event is distinct from 'ClientRead'
          and now() - query_start > interval '60 seconds')
        -- abandoned resultset: computed, but the client never read it
        or (state = 'active' and wait_event = 'ClientRead'
          and now() - query_start > interval '30 seconds')
        -- orphaned transaction: holds locks/backends while doing nothing
        or (state = 'idle in transaction'
          and now() - state_change > interval '60 seconds')
      )
  ) t;
$$;

revoke all on function public.reap_stuck_app_backends() from public;

-- Re-runnable: drop a pre-existing job with the same name before scheduling.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'reap-stuck-app-backends';
exception when others then
  null; -- no prior job
end $$;

select cron.schedule(
  'reap-stuck-app-backends',
  '* * * * *',
  $$select public.reap_stuck_app_backends()$$
);
