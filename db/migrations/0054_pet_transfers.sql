-- Pet transfers (owner → owner) — handoff P3-2.
--
-- Handshake table for owner→owner pet custody transfer. The current owner
-- initiates by recipient email; the recipient accepts (or rejects) inside
-- the 7-day window. Expiration runs daily via /api/cron/expire-pet-transfers.
--
-- to_owner_id is nullable until the recipient signs up and accepts.

CREATE TABLE IF NOT EXISTS pet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token text NOT NULL UNIQUE,
  pet_id uuid NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  from_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_owner_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  to_owner_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  note text,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  rejection_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_transfers_status_valid
    CHECK (status IN ('pending','accepted','rejected','expired','cancelled')),
  CONSTRAINT pet_transfers_reason_valid
    CHECK (reason IS NULL OR reason IN ('sale','gift','inheritance','other')),
  CONSTRAINT pet_transfers_expiry_after_init
    CHECK (expires_at > initiated_at)
);

-- At most one pending transfer per pet — concurrent transfers would race on
-- ownership transition. Partial unique so closed transfers don't block.
CREATE UNIQUE INDEX IF NOT EXISTS pet_transfers_one_pending_per_pet
  ON pet_transfers(pet_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pet_transfers_from_owner_idx ON pet_transfers(from_owner_id);
CREATE INDEX IF NOT EXISTS pet_transfers_to_owner_idx   ON pet_transfers(to_owner_id);
CREATE INDEX IF NOT EXISTS pet_transfers_to_email_idx   ON pet_transfers(to_owner_email);
CREATE INDEX IF NOT EXISTS pet_transfers_status_idx     ON pet_transfers(status, expires_at);

COMMENT ON TABLE pet_transfers IS
  'Owner→owner pet custody transfer handshake. 7-day expiry. Drained by /api/cron/expire-pet-transfers.';
