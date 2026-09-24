-- Migration 0077: unique active shelter_custody per pet per org
--
-- Prevents duplicate active shelter_custody rows for the same (pet, org) pair,
-- which could otherwise be inserted by concurrent orgAcceptOwnerReturnWriter
-- calls (TOCTOU race). The advisory lock in the writer is the belt; this
-- unique index is the suspenders.
--
-- Partial unique index: only enforced when role='shelter_custody' AND ended_at IS NULL.
-- Ended rows (historical) are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS ownerships_one_active_shelter_custody_per_pet_org
  ON ownerships(pet_id, owner_organization_id)
  WHERE role = 'shelter_custody' AND ended_at IS NULL;
