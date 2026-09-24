-- Cases (expedientes) — schema foundation. Fase A del plan de cases system
-- (docs/superpowers/plans/2026-05-19-cases-system.md).
--
-- Tabla `cases` que coordina como un envoltorio liviano sobre el event log.
-- Cada `pet_events` y `welfare_reports` row puede atarse a un caso vía
-- `case_id` nullable. Las cases son polimórficas en su sujeto (pet
-- registrado, animal sin owner, location, general).
--
-- Spec de referencia: docs/superpowers/specs/2026-05-19-cases-event-attachment-design.md (v1.1+)
-- Lifecycles spec: docs/superpowers/specs/2026-05-19-cases-lifecycles-design.md (v1.0+)
--
-- Idempotente — safe to re-run.

-- ===========================================================================
-- Tabla cases
-- ===========================================================================

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  public_code text not null unique,
  case_kind text not null,

  -- Status enum: open | escalated | closed | merged
  status text not null default 'open' check (status in ('open', 'escalated', 'closed', 'merged')),
  closed_reason text check (closed_reason is null or closed_reason in ('resolved', 'cancelled', 'auto_expired', 'merged')),
  superseded_by_case_id uuid references public.cases(id),

  -- Sujeto polimórfico
  primary_subject_kind text not null check (primary_subject_kind in ('registered_pet', 'unowned_animal', 'location', 'general')),
  primary_pet_id uuid references public.pets(id),
  primary_location_lat numeric(10, 7),
  primary_location_lng numeric(10, 7),

  -- Para adoption_application (escrito una sola vez al open). Sin FK
  -- explícita acá porque adoption_applications no es una tabla — la
  -- "application" es un pet_events row de tipo adoption_application_submitted.
  -- Sí trackeamos el applicant para unique index.
  applicant_user_id uuid references public.profiles(id),

  -- Jurisdicción (denormalizada desde primary_pet o location)
  jurisdiction_country text not null default 'AR',
  jurisdiction_province text,
  jurisdiction_locality text,

  -- Apertura
  opened_at timestamptz not null default now(),
  opened_by_user_id uuid references public.profiles(id),
  opened_by_organization_id uuid references public.organizations(id),
  opened_reason text,

  -- Cierre
  closed_at timestamptz,
  closed_by_user_id uuid references public.profiles(id),

  -- Linkbacks a tablas auxiliares (opcionales según kind)
  welfare_report_id uuid references public.welfare_reports(id),
  -- adoption_application_id queda sin FK hasta que aterrice la tabla
  -- adoption_applications (post adoption-listing-public spec)
  adoption_application_id uuid,
  custody_dispute_id uuid references public.custody_disputes(id),

  -- Para adoption_application: linkage al listing padre
  parent_listing_case_id uuid references public.cases(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===========================================================================
-- CHECK constraints (idempotent re-add)
-- ===========================================================================

do $$ begin
  alter table public.cases drop constraint if exists cases_subject_pet_consistency;
exception when others then null; end $$;

alter table public.cases
  add constraint cases_subject_pet_consistency
  check ((primary_subject_kind = 'registered_pet') = (primary_pet_id is not null));

do $$ begin
  alter table public.cases drop constraint if exists cases_subject_location_consistency;
exception when others then null; end $$;

alter table public.cases
  add constraint cases_subject_location_consistency
  check (
    (primary_subject_kind = 'location')
    = (primary_location_lat is not null and primary_location_lng is not null)
  );

do $$ begin
  alter table public.cases drop constraint if exists cases_merged_consistency;
exception when others then null; end $$;

alter table public.cases
  add constraint cases_merged_consistency
  check (
    (status = 'merged')
    = (superseded_by_case_id is not null and closed_reason = 'merged')
  );

do $$ begin
  alter table public.cases drop constraint if exists cases_closed_consistency;
exception when others then null; end $$;

alter table public.cases
  add constraint cases_closed_consistency
  check ((status in ('closed', 'merged')) = (closed_at is not null));

do $$ begin
  alter table public.cases drop constraint if exists cases_opened_reason_min_length;
exception when others then null; end $$;

alter table public.cases
  add constraint cases_opened_reason_min_length
  check (opened_reason is null or length(opened_reason) >= 10);

-- ===========================================================================
-- Partial unique indexes — enforce business uniqueness per kind
-- ===========================================================================

-- General: one open case per (pet, kind) except for the kinds that allow
-- multiple concurrent open cases (adoption_application has multi-applicants,
-- adoption_listing can have multiple orgs, welfare_denuncia can be opened
-- by anonymous reporters independently, foster_placement can rotate fosters).
create unique index if not exists cases_open_per_pet_kind_idx
  on public.cases (primary_pet_id, case_kind)
  where status in ('open', 'escalated')
    and case_kind not in (
      'adoption_application', 'adoption_listing',
      'welfare_denuncia', 'foster_placement'
    );

-- adoption_application: uniqueness by (pet, applicant) while open.
create unique index if not exists cases_open_adoption_app_per_applicant_idx
  on public.cases (primary_pet_id, applicant_user_id)
  where status in ('open', 'escalated') and case_kind = 'adoption_application';

-- adoption_listing: uniqueness by (pet, org) while open.
create unique index if not exists cases_open_adoption_listing_per_org_idx
  on public.cases (primary_pet_id, opened_by_organization_id)
  where status in ('open', 'escalated') and case_kind = 'adoption_listing';

-- Lookups for queues
create index if not exists cases_open_by_jurisdiction_kind_idx
  on public.cases (jurisdiction_locality, case_kind)
  where status in ('open', 'escalated');

create index if not exists cases_open_by_owner_pet_idx
  on public.cases (primary_pet_id)
  where status in ('open', 'escalated');

-- ===========================================================================
-- FK columns on existing tables
-- ===========================================================================

alter table public.pet_events
  add column if not exists case_id uuid references public.cases(id) on delete restrict;

create index if not exists pet_events_case_id_idx
  on public.pet_events (case_id)
  where case_id is not null;

alter table public.welfare_reports
  add column if not exists case_id uuid references public.cases(id) on delete restrict;

create index if not exists welfare_reports_case_id_idx
  on public.welfare_reports (case_id)
  where case_id is not null;

alter table public.notifications
  add column if not exists related_case_id uuid references public.cases(id) on delete set null;

create index if not exists notifications_related_case_id_idx
  on public.notifications (related_case_id)
  where related_case_id is not null;

-- ===========================================================================
-- Trigger: pet_events.case_id is append-only (defense in depth — the event
-- log is already append-only at the row level; this protects the case_id
-- assignment from being silently re-pointed.)
-- ===========================================================================

create or replace function public.check_pet_event_case_id_immutable()
  returns trigger as $$
begin
  if old.case_id is distinct from new.case_id then
    raise exception 'case_id on pet_events is append-only (was %, attempted %)',
      old.case_id, new.case_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists pet_events_case_id_immutable on public.pet_events;
create trigger pet_events_case_id_immutable
  before update on public.pet_events
  for each row
  execute function public.check_pet_event_case_id_immutable();

-- ===========================================================================
-- updated_at trigger for cases
-- ===========================================================================

create or replace function public.cases_set_updated_at()
  returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists cases_set_updated_at on public.cases;
create trigger cases_set_updated_at
  before update on public.cases
  for each row
  execute function public.cases_set_updated_at();
