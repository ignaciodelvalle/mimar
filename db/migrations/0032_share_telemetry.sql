-- Share telemetry — catalog cleanup 2026-05-19.
--
-- Tier-2 libreta share-view tracking lives here instead of `pet_events`
-- (where the prior `libreta_shared_viewed` event_type was non-clinical
-- noise). Server-only; no RLS — only `app/actions/libreta-share.ts`
-- writes to it.
--
-- Idempotent — safe to re-run.

create table if not exists public.share_telemetry (
  id              uuid primary key default gen_random_uuid(),
  pet_id          uuid not null references public.pets(id) on delete cascade,
  share_token_id  uuid not null references public.libreta_share_tokens(id) on delete cascade,
  viewed_at       timestamptz not null default now(),
  viewer_ip_hash  text,
  user_agent      text
);

create index if not exists share_telemetry_pet_idx
  on public.share_telemetry(pet_id);
create index if not exists share_telemetry_token_viewed_idx
  on public.share_telemetry(share_token_id, viewed_at);
