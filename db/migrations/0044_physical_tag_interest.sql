-- Physical tag interest (placeholder per §4.20 / spec
-- docs/superpowers/specs/2026-05-21-physical-tag-placeholder-design.md).
--
-- Captures owner demand for the future physical-QR-tag product without
-- implementing the actual product chain (manufacturer, serials, `/t/[serial]`
-- redirect). One row per (pet, user) — second click cancels (soft) and
-- third re-interests by clearing `cancelled_at`.
--
-- Idempotent — safe to re-run.

create table if not exists public.physical_tag_interest (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  notified_at timestamptz,
  notes text
);

-- Uniqueness across the (pet, user) pair — toggle re-uses the existing row
-- by flipping cancelled_at, never inserting a duplicate.
create unique index if not exists physical_tag_interest_pet_user_unique
  on public.physical_tag_interest (pet_id, user_id);

-- Hot paths: list of active interests for a pet (Step C: notify when product
-- exists), and global stream for the analytics-by-locality query in §5 of
-- the spec.
create index if not exists physical_tag_interest_pet_active_idx
  on public.physical_tag_interest (pet_id)
  where cancelled_at is null;

create index if not exists physical_tag_interest_active_created_idx
  on public.physical_tag_interest (created_at desc)
  where cancelled_at is null;
