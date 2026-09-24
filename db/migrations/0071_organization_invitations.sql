-- Migration 0071: organization_invitations — link-based member invite flow.
--
-- Design:
--  - Invite is email-tied: acceptance requires the logged-in user's email to
--    match the invitation email exactly (case-insensitive).
--  - Role fixed at invite time, bounded by the inviter's role rank.
--  - Invitable roles: admin, coordinator, member, volunteer, vet_individual.
--    foster membership comes via the foster-proposal flow — not staff invites.
--  - Delivery: shareable link (/r/invite/<token>). No email in this migration.
--  - Expiry default: 14 days from creation.
--  - No duplicate ACTIVE invite for (org, lower(email)): enforced via partial
--    unique index WHERE accepted_at IS NULL AND revoked_at IS NULL.
--  - Re-invite is allowed after expiry / revoke / accept.

CREATE TABLE IF NOT EXISTS organization_invitations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                 text        NOT NULL,
  invited_role          organization_membership_role NOT NULL,
  can_write_pet_events  boolean     NOT NULL DEFAULT false,
  invited_by_user_id    uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  invitation_token      text        NOT NULL UNIQUE,
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at           timestamptz,
  accepted_by_user_id   uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Lookup by org (admin views pending invitations).
CREATE INDEX IF NOT EXISTS org_invitations_org_id_idx
  ON organization_invitations (organization_id);

-- Fast token lookup at accept time.
CREATE INDEX IF NOT EXISTS org_invitations_token_idx
  ON organization_invitations (invitation_token);

-- Email index for duplicate-detection and member-already-exists checks.
CREATE INDEX IF NOT EXISTS org_invitations_email_idx
  ON organization_invitations (email);

-- Exactly one active (non-accepted, non-revoked) invite per (org, email).
-- Partial unique index covers only the active slice; closed invites do not
-- block re-invites.
CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_active_unique
  ON organization_invitations (organization_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE organization_invitations IS
  'Link-based org member invitations. One active invite per (org, email) enforced
   by partial unique index. Acceptance requires the logged-in user email to match
   the invitation email exactly. Foster role excluded — comes via foster-proposal
   flow.';
