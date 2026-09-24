-- Migration 0072: partial unique index on organization_memberships (org, user)
-- WHERE left_at IS NULL.
--
-- Rationale: prevents duplicate active memberships that could be created by two
-- concurrent invite-accepts racing through the same (or different) invite tokens.
-- The FOR UPDATE lock in acceptInvitationAction is the primary guard; this index
-- is the final DB-level safety net.
--
-- Safe to add: verified no existing duplicate active (org, user) rows exist
-- by inspecting the codebase — all membership inserts pair a distinct user with
-- a distinct org, and the accept flow guards against re-inserting if already
-- a member. Historical data is clean.

CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_active_unique
  ON organization_memberships (organization_id, user_id)
  WHERE left_at IS NULL;
