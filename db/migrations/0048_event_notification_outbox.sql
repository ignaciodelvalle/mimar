-- 0048_event_notification_outbox.sql
-- Adds the event_notification_outbox table for the ENO Event-Trust outbox
-- infrastructure (Tier 1, Fase C.1).
--
-- Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.1
-- Decisions: C1-C9 closed 2026-05-22.
--
-- The outbox is a durable delivery queue: every ENO-relevant pet event gets
-- a row inserted in the SAME transaction as the source event. A drainer cron
-- reads pending rows, calls target-kind handlers (v1 = no-op + audit), and
-- marks rows delivered or failed.
--
-- No RLS policies — outbox is system/service-role only in v1. The upcoming
-- admin UI (Fase C.2) will use the service-role Drizzle client.
--
-- IDEMPOTENT: all statements use IF NOT EXISTS.

begin;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type outbox_target_kind as enum (
    'govt_webhook',
    'eno_authority',
    'audit_export',
    'internal_dashboard'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type outbox_status as enum (
    'pending',
    'delivered',
    'failed'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.event_notification_outbox (
  id                          uuid primary key default gen_random_uuid(),

  -- Source event that triggered this outbox row. ON DELETE CASCADE so that if
  -- a test helper ever deletes a pet_event (via the mutation-override GUC),
  -- orphan outbox rows are also cleaned up.
  source_event_id             uuid not null
    references public.pet_events(id) on delete cascade,

  target_kind                 outbox_target_kind not null,

  -- Jurisdiction snapshot at enqueue time — used for webhook routing in v2.
  -- Nullable: outbreak_signal rows from pre-jurisdiction pets may omit these.
  target_jurisdiction_province  text,
  target_jurisdiction_locality  text,

  -- Snapshot of the source event's payload at enqueue time. Decoupled from
  -- the live event row so the drainer never needs to re-join pet_events.
  payload_snapshot            jsonb not null default '{}'::jsonb,

  -- Legal SLA deadline. Computed as now() + slaHours at enqueue time.
  sla_due_at                  timestamptz not null,

  -- Delivery lifecycle.
  status                      outbox_status not null default 'pending',
  attempts                    int not null default 0,
  last_attempt_at             timestamptz,
  last_error                  text,
  -- Initial value is now() so the drainer picks the row up immediately.
  next_retry_at               timestamptz not null default now(),
  delivered_at                timestamptz,

  created_at                  timestamptz not null default now()
);

comment on table public.event_notification_outbox is
  'Durable delivery queue for ENO (Enfermedades de Notificación Obligatoria) '
  'and other regulated event notifications. One row per (source_event, target). '
  'Inserted in the same transaction as the source event (atomicity guarantee). '
  'Drained by /api/cron/drain-outbox every 5 minutes.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Drainer index: pick up pending rows that are due (next_retry_at <= now()).
create index if not exists outbox_drainable_idx
  on public.event_notification_outbox (next_retry_at)
  where status = 'pending';

-- SLA monitoring: find rows approaching or past their SLA deadline.
create index if not exists outbox_sla_due_idx
  on public.event_notification_outbox (sla_due_at, status);

-- Reverse-lookup from source event to its outbox rows (for the admin UI).
create index if not exists outbox_source_event_idx
  on public.event_notification_outbox (source_event_id);

commit;
