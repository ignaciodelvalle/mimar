-- Health campaigns and scheduling — schema foundation (Fase 0)
-- Adds service_offerings (polymorphic provider, XOR enforced),
-- service_schedule_rules, time_slots, appointments tables.
-- Extends reminders with appointment_id FK.
--
-- All DDL uses CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS for
-- idempotency (safe to re-run on the same environment).

-- ============================================================================
-- service_offerings
-- ============================================================================
-- A specific service an org (or independent vet) wants to offer.
-- Provider is polymorphic: exactly one of organization_id / provider_user_id
-- is set per row, enforced by the provider_xor CHECK constraint.
-- Jurisdiction columns are denormalized from the provider so approval routing
-- works independently of who the provider is.

create table if not exists public.service_offerings (
  id                          uuid primary key default gen_random_uuid(),
  public_token                text not null unique,           -- e.g. SVO-XXXX-XXXX

  -- Polymorphic provider: exactly one must be set (XOR)
  organization_id             uuid references public.organizations(id) on delete cascade,
  provider_user_id            uuid references public.profiles(id) on delete cascade,

  -- Jurisdiction denormalized for approval routing
  jurisdiction_country        text not null default 'AR',
  jurisdiction_province       text,
  jurisdiction_locality       text,

  service_kind                text not null,
  display_name                text not null,
  description                 text,
  duration_minutes            int not null default 15,
  slot_capacity               int not null default 1,
  price_ars                   numeric(10, 2),                 -- null = free / campaign
  eligibility_species         text[],                         -- null = any species
  eligibility_age_min_months  int,
  eligibility_age_max_months  int,

  -- Approval workflow (D8: status column, not approval_requests table)
  status                      text not null default 'pending_approval',
  submitted_at                timestamptz not null default now(),
  reviewed_at                 timestamptz,
  reviewed_by_user_id         uuid references public.profiles(id),
  rejection_reason            text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint provider_xor check (
    (organization_id is not null and provider_user_id is null)
    or (organization_id is null and provider_user_id is not null)
  ),
  constraint service_status_valid check (
    status in ('pending_approval', 'approved', 'rejected', 'paused', 'archived')
  ),
  constraint service_capacity_positive check (slot_capacity > 0),
  constraint service_duration_positive check (duration_minutes > 0)
);

create index if not exists service_offerings_org_idx
  on public.service_offerings (organization_id)
  where organization_id is not null;

create index if not exists service_offerings_provider_idx
  on public.service_offerings (provider_user_id)
  where provider_user_id is not null;

create index if not exists service_offerings_pending_idx
  on public.service_offerings (status, submitted_at)
  where status = 'pending_approval';

create index if not exists service_offerings_active_search_idx
  on public.service_offerings (service_kind, status)
  where status = 'approved';

create index if not exists service_offerings_jurisdiction_idx
  on public.service_offerings (jurisdiction_country, jurisdiction_province, jurisdiction_locality);

comment on table public.service_offerings is
  'Service an org or independent vet wants to offer. Admin (or scoped govt) approves via status workflow before provider can create slots.';
comment on column public.service_offerings.status is
  'Lifecycle: pending_approval → approved | rejected. After approved: paused / archived by provider.';
comment on column public.service_offerings.organization_id is
  'Set when provider is an organization. Mutually exclusive with provider_user_id (XOR enforced).';
comment on column public.service_offerings.provider_user_id is
  'Set when provider is an independent vet (professional.provider capability). Mutually exclusive with organization_id (XOR enforced).';

-- ============================================================================
-- service_schedule_rules
-- ============================================================================
-- Weekly recurring availability for a service offering.
-- Discrete fields (days of week + time window + effective date range) cover
-- 100% of Argentine vet patterns; RRULE is out of scope (D4).

create table if not exists public.service_schedule_rules (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references public.service_offerings(id) on delete cascade,
  days_of_week        smallint[] not null,          -- ISO 8601: 1=Mon..7=Sun
  start_time_local    time not null,
  end_time_local      time not null,
  effective_from      date not null,
  effective_until     date,                          -- null = open-ended
  timezone            text not null default 'America/Argentina/Buenos_Aires',
  status              text not null default 'active',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint rule_time_window_sane check (end_time_local > start_time_local),
  constraint rule_dates_sane
    check (effective_until is null or effective_until >= effective_from),
  constraint rule_days_nonempty check (array_length(days_of_week, 1) > 0),
  constraint rule_status_valid check (status in ('active', 'paused', 'archived'))
);

create index if not exists schedule_rules_offering_active_idx
  on public.service_schedule_rules (service_offering_id)
  where status = 'active';

comment on table public.service_schedule_rules is
  'Weekly recurring availability rules for a service offering. Cron materializes slots from active rules within a 60-day rolling window.';

-- ============================================================================
-- time_slots
-- ============================================================================
-- Discrete bookable slots materialized from schedule rules.
-- bookings_count <= capacity is the final guardrail against race conditions
-- (D10: advisory lock is the primary mitigation, this is the safety net).

create table if not exists public.time_slots (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references public.service_offerings(id) on delete cascade,
  rule_id             uuid references public.service_schedule_rules(id) on delete set null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  capacity            int not null,         -- snapshot from offering.slot_capacity at materialization
  bookings_count      int not null default 0,
  status              text not null default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint slot_window_sane check (ends_at > starts_at),
  constraint slot_capacity_positive check (capacity > 0),
  constraint slot_bookings_non_negative check (bookings_count >= 0),
  constraint slot_bookings_within_capacity check (bookings_count <= capacity),
  constraint slot_status_valid check (status in ('open', 'full', 'cancelled'))
);

create unique index if not exists time_slots_unique_starts
  on public.time_slots (service_offering_id, starts_at);

create index if not exists time_slots_offering_window_idx
  on public.time_slots (service_offering_id, starts_at)
  where status = 'open';

create index if not exists time_slots_search_idx
  on public.time_slots (service_offering_id, starts_at)
  where status in ('open', 'full');

comment on table public.time_slots is
  'Discrete bookable slots materialized from service_schedule_rules. Idempotent cron regenerates daily for 60-day rolling window.';
comment on column public.time_slots.capacity is
  'Snapshot from service_offerings.slot_capacity at materialization. Re-materialization can change it only for slots without bookings.';

-- ============================================================================
-- appointments
-- ============================================================================
-- Owner bookings against time slots. Mutable planning artifact (D6): can be
-- cancelled; the outcome pet_event is immutable and linked via outcome_event_id.
-- organization_id is denormalized (nullable for independent-vet offerings).

create table if not exists public.appointments (
  id                       uuid primary key default gen_random_uuid(),
  public_token             text not null unique,                          -- e.g. APT-XXXX-XXXX
  slot_id                  uuid not null references public.time_slots(id) on delete restrict,
  pet_id                   uuid not null references public.pets(id) on delete cascade,
  owner_user_id            uuid not null references public.profiles(id) on delete cascade,
  service_offering_id      uuid not null references public.service_offerings(id),
  -- Denormalized: set for org offerings, null for independent-vet offerings
  organization_id          uuid references public.organizations(id),
  status                   text not null default 'confirmed',

  attended_at              timestamptz,
  attended_by_user_id      uuid references public.profiles(id),
  cancelled_at             timestamptz,
  cancelled_by_user_id     uuid references public.profiles(id),
  cancellation_reason      text,
  no_show_marked_at        timestamptz,
  outcome_event_id         uuid references public.pet_events(id),
  reminder_id              uuid references public.reminders(id),
  notes_from_owner         text,
  notes_from_org           text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint appointment_status_valid check (status in (
    'confirmed', 'attended', 'no_show', 'cancelled_by_owner', 'cancelled_by_org'
  )),
  constraint appointment_outcome_only_when_attended
    check ((outcome_event_id is null) or (status = 'attended'))
);

create index if not exists appointments_pet_idx
  on public.appointments (pet_id, created_at desc);

create index if not exists appointments_owner_idx
  on public.appointments (owner_user_id, status);

create index if not exists appointments_org_idx
  on public.appointments (organization_id, status)
  where organization_id is not null;

create index if not exists appointments_slot_idx
  on public.appointments (slot_id)
  where status = 'confirmed';

comment on table public.appointments is
  'Owner bookings against time slots. Mutable: can be cancelled or marked attended. Source of truth for planning; pet_events is the immutable medical record.';
comment on column public.appointments.outcome_event_id is
  'Set when status=attended. Links to the emitted pet_event (vaccination_administered, sterilization_performed, etc.).';
comment on column public.appointments.organization_id is
  'Denormalized from service_offering. Set for org offerings; null for independent-vet offerings.';

-- ============================================================================
-- reminders extension: appointment_id FK
-- ============================================================================
-- Reminder without appointment = private owner note (existing flow, unchanged).
-- Reminder with appointment = backed by a real booking. Both coexist (D7).

alter table public.reminders
  add column if not exists appointment_id uuid
  references public.appointments(id) on delete set null;

create index if not exists reminders_appointment_idx
  on public.reminders (appointment_id)
  where appointment_id is not null;

comment on column public.reminders.appointment_id is
  'Optional link to a real appointment. Null = personal reminder only (existing flow). Non-null = reminder backed by an actual booking.';

-- Reverse rollback (documented, not executed in production):
-- alter table public.reminders drop column if exists appointment_id;
-- drop table if exists public.appointments;
-- drop table if exists public.time_slots;
-- drop table if exists public.service_schedule_rules;
-- drop table if exists public.service_offerings;
