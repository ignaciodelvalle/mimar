-- ENO processing queue (handoff P4-6).
--
-- One row per disease-diagnosis pet_event that needs the ENO fanout
-- (govt notifications + audit log). The event-insert action enqueues
-- here cheaply; the hourly cron worker (/api/cron/process-eno-queue)
-- drains pending rows.
--
-- Keeps pet_events itself pure (immutable); queue state lives here so
-- it can be retried on failure.

CREATE TABLE IF NOT EXISTS eno_processing_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  queued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT eno_processing_queue_status_check
    CHECK (status IN ('pending', 'processed', 'failed'))
);

-- Worker drains by (status, queued_at) — pick oldest pending first.
CREATE INDEX IF NOT EXISTS eno_processing_queue_status_idx
  ON eno_processing_queue(status, queued_at);

-- One row per pet_event — prevents double-enqueue on retried inserts.
CREATE UNIQUE INDEX IF NOT EXISTS eno_processing_queue_event_id_unique
  ON eno_processing_queue(pet_event_id);

COMMENT ON TABLE eno_processing_queue IS
  'Worker queue for ENO disease-diagnosis fanout. Drained hourly by /api/cron/process-eno-queue. One row per pet_event_id.';
