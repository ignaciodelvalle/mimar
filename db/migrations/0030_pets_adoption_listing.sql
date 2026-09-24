-- Adoption listing — schema foundation (spec 2026-05-18 adoption-listing-public v1.3).
-- Adds 11 columns to `pets` that capture both the listing toggle and the
-- shelter-curated copy that renders on /adoptar. Free-text where the
-- product wants flexibility; enum-style CHECK where guardrails matter.
--
-- All columns are nullable: a shelter can list a pet with story alone and
-- backfill the rest later. The partial index speeds up the public listing
-- query — only rows that are actually visible (listed and not paused).
--
-- Idempotent — safe to re-run.

alter table public.pets
  add column if not exists adoption_listed_at         timestamptz,
  add column if not exists adoption_listing_paused_at timestamptz,
  add column if not exists adoption_story             text,
  add column if not exists adoption_requirements      text,
  add column if not exists adoption_energy_level      text,
  add column if not exists adoption_size_estimate     text,
  add column if not exists adoption_age_bucket        text,
  add column if not exists adoption_good_with_kids    boolean,
  add column if not exists adoption_good_with_dogs    boolean,
  add column if not exists adoption_good_with_cats    boolean,
  add column if not exists adoption_needs_yard        boolean,
  add column if not exists adoption_fee_ars           integer;

-- Drop & re-add CHECKs in a DO block so the migration stays idempotent
-- across partial re-applies (a previous run may have created some).
do $$
begin
  alter table public.pets drop constraint if exists pets_adoption_energy_level_valid;
exception when others then null;
end$$;

alter table public.pets
  add constraint pets_adoption_energy_level_valid
  check (adoption_energy_level is null or adoption_energy_level in ('low','medium','high'));

do $$
begin
  alter table public.pets drop constraint if exists pets_adoption_size_estimate_valid;
exception when others then null;
end$$;

alter table public.pets
  add constraint pets_adoption_size_estimate_valid
  check (adoption_size_estimate is null or adoption_size_estimate in ('small','medium','large','xl'));

do $$
begin
  alter table public.pets drop constraint if exists pets_adoption_age_bucket_valid;
exception when others then null;
end$$;

alter table public.pets
  add constraint pets_adoption_age_bucket_valid
  check (adoption_age_bucket is null or adoption_age_bucket in ('puppy','junior','young','adult','senior'));

do $$
begin
  alter table public.pets drop constraint if exists pets_adoption_fee_non_negative;
exception when others then null;
end$$;

alter table public.pets
  add constraint pets_adoption_fee_non_negative
  check (adoption_fee_ars is null or adoption_fee_ars >= 0);

-- Partial index for the public listing query: only rows that are listed
-- AND not paused. Sorted descending so the keyset cursor scan walks the
-- index in order.
create index if not exists pets_adoption_listing_active_idx
  on public.pets (adoption_listed_at desc, id desc)
  where adoption_listed_at is not null
    and adoption_listing_paused_at is null;
