-- Migration 0093: backfill event.write capability grants
--
-- For every ACTIVE membership (left_at IS NULL) with can_write_pet_events = true
-- and role NOT IN ('admin', 'vet_individual') that has NO existing grant row with
-- capability = 'event.write' AND status IN ('pending', 'approved'), insert an
-- approved organization_capability_grants row.
--
-- These memberships were created before the capability-grant path existed
-- (set-member-event-write and accept-invitation now write the grant row, but
-- existing rows predate that logic).
--
-- Idempotent: the WHERE NOT EXISTS guard prevents duplicate inserts on re-run.

INSERT INTO organization_capability_grants (
  membership_id,
  organization_id,
  capability,
  status,
  decided_at,
  decision_reason,
  decided_by_user_id
)
SELECT
  m.id,
  m.organization_id,
  'event.write',
  'approved',
  now(),
  'backfill-0093',
  NULL
FROM organization_memberships m
WHERE m.left_at IS NULL
  AND m.can_write_pet_events = true
  AND m.role NOT IN ('admin', 'vet_individual')
  AND NOT EXISTS (
    SELECT 1
    FROM organization_capability_grants g
    WHERE g.membership_id = m.id
      AND g.capability = 'event.write'
      AND g.status IN ('pending', 'approved')
  );
