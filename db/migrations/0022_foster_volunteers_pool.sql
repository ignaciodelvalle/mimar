-- Foster volunteers pool — foundation.
--
-- Implements §4.1, §4.2, §4.4 of
-- docs/superpowers/specs/2026-05-18-foster-volunteers-pool-design.md v1.4.
--
-- foster_volunteers — pool single-row-per-user (D1) with the D16 slot model:
--   each enrollment adds +1 slot, each accepted proposal subtracts -1; the
--   row only appears in org searches when status='active' AND available_slots>0.
--
-- foster_proposals — concrete org→volunteer proposals for a specific pet
-- (D6), 5-status lifecycle (pending/accepted/rejected/expired/cancelled) with
-- inline CHECKs that keep the marker columns coherent per status.
--
-- ownerships.allow_co_foster — D17 opt-in flag on foster ownership rows so
-- the first foster controls whether the org can assign a parallel second
-- foster over the same pet. Ignored on rows where role != 'foster'.
--
-- Idempotent: every CREATE wrapped in IF NOT EXISTS; ALTER ADD COLUMN guarded.
--
-- Applied via:
--   cat db/migrations/0022_foster_volunteers_pool.sql | \
--     docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

-- 1) foster_volunteers
create table if not exists public.foster_volunteers (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique
                                  references public.profiles(id) on delete cascade,

  status                        text not null default 'active',
  available_slots               integer not null default 0,

  jurisdiction_province         text,
  jurisdiction_locality         text,

  accepts_dogs                  boolean not null default false,
  accepts_cats                  boolean not null default false,
  accepts_other_species         boolean not null default false,

  accepts_size_small            boolean not null default true,
  accepts_size_medium           boolean not null default true,
  accepts_size_large            boolean not null default false,

  accepts_puppies               boolean not null default false,
  accepts_seniors               boolean not null default true,

  accepts_chronic_conditions    boolean not null default false,
  accepts_dangerous_breeds      boolean not null default false,

  max_duration_weeks            integer,
  household_other_pets          boolean,
  household_kids                boolean,

  notes                         text,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_volunteers_status_valid check (
    status in ('active','paused','withdrawn')
  ),
  constraint foster_volunteers_slots_non_negative check (available_slots >= 0),
  constraint foster_volunteers_at_least_one_species check (
    status != 'active'
    or (accepts_dogs or accepts_cats or accepts_other_species)
  )
);

create index if not exists foster_volunteers_pool_idx
  on public.foster_volunteers (status)
  where status = 'active' and available_slots > 0;

create index if not exists foster_volunteers_locality_idx
  on public.foster_volunteers (jurisdiction_province, jurisdiction_locality)
  where status = 'active' and available_slots > 0;

create index if not exists foster_volunteers_user_idx
  on public.foster_volunteers (user_id);

-- 2) foster_proposals
create table if not exists public.foster_proposals (
  id                            uuid primary key default gen_random_uuid(),
  public_token                  text not null unique,

  organization_id               uuid not null
                                  references public.organizations(id) on delete cascade,
  volunteer_user_id             uuid not null
                                  references public.profiles(id) on delete cascade,
  pet_id                        uuid not null
                                  references public.pets(id) on delete cascade,
  proposed_by_user_id           uuid not null references public.profiles(id),

  proposed_at                   timestamptz not null default now(),
  proposed_duration_weeks       integer,
  proposed_notes                text,
  match_warnings                jsonb not null default '[]'::jsonb,
  expires_at                    timestamptz not null,

  status                        text not null default 'pending',

  responded_at                  timestamptz,
  response_notes                text,
  rejection_reason              text,

  cancelled_at                  timestamptz,
  cancelled_by_user_id          uuid references public.profiles(id),
  cancellation_reason           text,

  resolved_ownership_id         uuid references public.ownerships(id),

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_proposals_status_valid check (status in (
    'pending','accepted','rejected','expired','cancelled'
  )),
  constraint foster_proposals_rejection_reason_valid check (
    rejection_reason is null
    or rejection_reason in (
      'capacity','health_mismatch','timing','distance','household','other'
    )
  ),
  -- Each terminal status requires the matching marker fields populated.
  constraint foster_proposals_response_consistent check (
    (status = 'pending'   and responded_at is null and cancelled_at is null)
    or (status = 'accepted'  and responded_at is not null and resolved_ownership_id is not null)
    or (status = 'rejected'  and responded_at is not null)
    or (status = 'expired'   and (responded_at is null or expires_at <= responded_at))
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null)
  )
);

create index if not exists foster_proposals_volunteer_idx
  on public.foster_proposals (volunteer_user_id, status, proposed_at desc);
create index if not exists foster_proposals_org_idx
  on public.foster_proposals (organization_id, status, proposed_at desc);
create index if not exists foster_proposals_pet_idx
  on public.foster_proposals (pet_id)
  where status in ('pending','accepted');
create index if not exists foster_proposals_status_idx
  on public.foster_proposals (status, expires_at);

-- 3) ownerships.allow_co_foster (D17)
alter table public.ownerships
  add column if not exists allow_co_foster boolean not null default false;

comment on column public.ownerships.allow_co_foster is
  'Foster-only flag (D17): when role=foster and true, the org may assign additional co-fosters to the same pet. Ignored for other roles.';

-- 4) Documentation comments
comment on table public.foster_volunteers is
  'Pool of pet-owners voluntarily offering temporary foster care to shelter pets (spec v1.4 §4.1).';
comment on column public.foster_volunteers.available_slots is
  'D16 single-use slot model: +1 per enrollment, -1 per accept, prompt to re-enroll post-termination.';
comment on table public.foster_proposals is
  'Concrete org→volunteer foster proposals for a specific pet (spec v1.4 §4.2). Two-phase: propose then accept/reject/cancel.';
