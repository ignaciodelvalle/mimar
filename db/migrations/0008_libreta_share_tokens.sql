-- db/migrations/0008_libreta_share_tokens.sql
--
-- Tier-2 share tokens for the libreta sanitaria. Each row is one
-- shareable surface created by an owner; revocation is a flag flip,
-- expiry is a timestamp, and views are tracked via the pet_events log
-- (event_type='libreta_shared_viewed') so the share-token table itself
-- stays small.

create table if not exists "public"."libreta_share_tokens" (
  "id"                    uuid primary key default gen_random_uuid(),
  "share_token"           text not null unique,
  "pet_id"                uuid not null references "public"."pets"("id") on delete cascade,
  "created_by_user_id"    uuid not null references "public"."profiles"("id") on delete cascade,
  "label"                 text,
  "expires_at"            timestamptz,
  "revoked_at"            timestamptz,
  "revoked_by_user_id"    uuid references "public"."profiles"("id"),
  "view_count_cached"     int not null default 0,
  "last_viewed_at_cached" timestamptz,
  "created_at"            timestamptz not null default now()
);

create index if not exists "libreta_share_tokens_pet_idx"
  on "public"."libreta_share_tokens" ("pet_id")
  where revoked_at is null;

create index if not exists "libreta_share_tokens_token_idx"
  on "public"."libreta_share_tokens" ("share_token");

-- Reverse rollback (documented, not executed):
-- drop table public.libreta_share_tokens;
