-- Generic rate-limit counter with TTL. Used initially for anonymous welfare
-- report submissions; reusable for any endpoint that needs anti-spam without
-- adding a Redis dependency.
--
-- bucket_key encodes endpoint + identifier + window so disjoint endpoints
-- and disjoint windows don't compete with each other.

create table if not exists public.rate_limit_buckets (
  bucket_key      text primary key,
  count           integer not null default 1,
  first_seen_at   timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists rate_limit_buckets_expires_idx
  on public.rate_limit_buckets (expires_at);

comment on table public.rate_limit_buckets is
  'Generic counter with TTL for anti-spam. bucket_key encodes endpoint + identifier + window.';
