-- Permanent conditions — schema foundation (spec 2026-05-18
-- additional-species-and-permanent-conditions plan, condition catalog).
-- Adds 3 columns to `pets` that capture lifelong conditions disclosed by
-- the caregiver (ciego, sordo, tres_patas, fiv_positivo, etc.) plus an
-- explicit "publish in public surfaces" toggle so the dueño/refugio
-- controls how much of the medical/functional profile goes on /adoptar
-- and /p/{publicToken}.
--
-- Why text[]: the catalog (lib/permanent-conditions.ts) is curated +
-- enforced in app-layer. We don't enum-constraint at DB-level so the
-- catalog can grow without a migration each time. "otra" goes through
-- the dedicated `_other` free-text column so it stays auditable.
--
-- Idempotent — safe to re-run.

alter table public.pets
  add column if not exists permanent_conditions          text[]  not null default '{}',
  add column if not exists permanent_conditions_other    text,
  add column if not exists disclose_conditions_publicly  boolean not null default false;

-- "permanent_conditions_other" is meaningful ONLY when 'otra' is in the
-- array. CHECK: if no 'otra' tag, the column must be null. We don't
-- prevent the array from being empty when the column is null — that's
-- the default state for every pet that has no recorded conditions.

do $$
begin
  alter table public.pets drop constraint if exists pets_conditions_other_consistent;
exception when others then null;
end$$;

alter table public.pets
  add constraint pets_conditions_other_consistent
  check (
    permanent_conditions_other is null
    or 'otra' = any(permanent_conditions)
  );

-- GIN index for filtering by condition tag (e.g. "/adoptar?ciego=true").
-- Cheap on small tables, pays off as the catalog grows.
create index if not exists pets_permanent_conditions_gin
  on public.pets using gin (permanent_conditions);
