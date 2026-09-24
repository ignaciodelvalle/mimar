-- 0047_event_client_idempotency_key.sql
-- Adds client_idempotency_key to pet_events for ENO Event-Trust Tier 1 Fase B.
-- Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 Fase B
-- Decisions B1-B8 closed. Column is nullable so existing rows and admin
-- writes (no key) are unaffected. The partial unique index enforces
-- last-stable-wins idempotency on (pet_id, event_type, key) for non-null keys.

begin;

alter table public.pet_events
  add column if not exists client_idempotency_key uuid;

comment on column public.pet_events.client_idempotency_key is
  'UUID v4 generated client-side before form submission. NULL for events '
  'written by admin tools or any path that does not supply a key. When '
  'present, the partial unique index (B1) prevents double-inserts from '
  'network retries — same (pet_id, event_type, key) returns the original '
  'row instead of inserting a duplicate (ON CONFLICT DO NOTHING + fetch).';

-- Partial unique index: only rows with a non-null key participate.
-- This keeps the index small, makes NULL rows unaffected, and is exactly
-- the "last-stable-wins" semantics from decision B8.
create unique index if not exists pet_events_idempotency_idx
  on public.pet_events (pet_id, event_type, client_idempotency_key)
  where client_idempotency_key is not null;

commit;
