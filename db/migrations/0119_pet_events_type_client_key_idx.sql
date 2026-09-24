-- 0119: partial index for cross-pet idempotency lookups on pet_events.
--
-- The org-intake idempotency guard (projection-writes audit §6) looks up
-- pet_registered events by (event_type, client_idempotency_key) BEFORE a pet
-- exists, so the existing pet_events_idempotency_idx — which leads with
-- pet_id — cannot serve the query. This partial index covers that lookup
-- (and any future cross-pet dedupe by key) without indexing the vast
-- majority of rows where the key is NULL.

CREATE INDEX IF NOT EXISTS pet_events_type_client_key_idx
  ON pet_events (event_type, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
