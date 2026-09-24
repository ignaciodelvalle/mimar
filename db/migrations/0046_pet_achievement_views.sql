-- pet_achievement_views: tracks when an owner first sees an earned achievement.
--
-- Purpose: drives the badge-pulse UX (animate-pulse Tailwind class) on the
-- pet profile v2 achievements row. A view row is created lazily on the first
-- profile load for each (user, pet, achievement) triple. The `pulse_until`
-- column controls the 7-day pulse window; it decays naturally (no explicit
-- clear needed — idempotent on re-visit via onConflictDoNothing).
--
-- RLS: owner-only via ownerships join (mirrors 0026_pet_service_dog.sql).
-- All writes go through markAchievementSeenAction (Drizzle service role,
-- bypasses RLS). RLS SELECT policy is the load-bearing isolation guarantee
-- for future supabase-js read paths.
--
-- Idempotent — safe to re-run.

create table if not exists public.pet_achievement_views (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id)  on delete cascade,
  pet_id         uuid not null references public.pets(id)      on delete cascade,
  achievement_id text not null,
  first_seen_at  timestamptz not null default now(),
  pulse_until    timestamptz not null default (now() + interval '7 days')
);

-- Natural key: one view row per (user, pet, achievement).
-- Used by the upsert path in markAchievementSeenAction.
create unique index if not exists pet_achievement_views_owner_pet_ach_unique
  on public.pet_achievement_views (user_id, pet_id, achievement_id);

-- Hot-path index: look up all view rows for a (user, pet) pair in one query
-- on profile load (JOIN against earned achievements).
create index if not exists pet_achievement_views_user_pet_idx
  on public.pet_achievement_views (user_id, pet_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.pet_achievement_views enable row level security;

-- SELECT: owner reads own rows while they still hold custody of the pet.
drop policy if exists "achievement_views select by owner" on public.pet_achievement_views;
create policy "achievement_views select by owner"
  on public.pet_achievement_views for select
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.ownerships o
      where o.pet_id     = pet_achievement_views.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at   is null
    )
  );

-- INSERT: owner may insert rows for their own pets.
-- (markAchievementSeenAction uses service-role Drizzle and bypasses RLS;
--  this policy is the defence-in-depth gate for any future direct write path.)
drop policy if exists "achievement_views insert by owner" on public.pet_achievement_views;
create policy "achievement_views insert by owner"
  on public.pet_achievement_views for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.ownerships o
      where o.pet_id     = pet_achievement_views.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at   is null
    )
  );

-- UPDATE: same predicate as INSERT (symmetric for future re-pulse path).
drop policy if exists "achievement_views update by owner" on public.pet_achievement_views;
create policy "achievement_views update by owner"
  on public.pet_achievement_views for update
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.ownerships o
      where o.pet_id     = pet_achievement_views.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at   is null
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.ownerships o
      where o.pet_id     = pet_achievement_views.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at   is null
    )
  );

-- No DELETE policy — write-once history (mirrors pet_events convention).
