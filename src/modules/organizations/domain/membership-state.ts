// Pure membership and grant state machine helpers.
// No DB imports, no Next.js imports — domain-only.
//
// Covers:
//   - lastAdminBlocks: guards against removing the last org admin
//   - inviteAcceptValidity: validates an org invitation before acceptance
//   - canDecide: grant state machine transition guard

// ---------------------------------------------------------------------------
// Invite shape — only the fields the pure logic needs (avoids DB row coupling)
// ---------------------------------------------------------------------------

type InviteState = {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  invitedEmail: string;
};

// Possible outcomes of inviteAcceptValidity
export type InviteAcceptOutcome =
  | "not_found"
  | "already_accepted"
  | "revoked"
  | "expired"
  | "email_mismatch"
  | "valid";

// Grant status values that can appear in the state machine
type GrantStatus = "pending" | "approved" | "denied" | "revoked";

// Decisions the admin can make on a grant
type GrantDecision = "approved" | "denied" | "revoked";

// ---------------------------------------------------------------------------
// lastAdminBlocks
//
// Checks whether removing or demoting an admin would leave the org without
// any admin. The caller runs SELECT ... FOR UPDATE before calling this, then
// passes the count of active admin rows returned.
//
// Returns true (block the action) when adminCount <= 1.
// ---------------------------------------------------------------------------

export function lastAdminBlocks(adminCount: number): boolean {
  return adminCount <= 1;
}

// ---------------------------------------------------------------------------
// inviteAcceptValidity
//
// Pure state check for an org invitation before the acceptance path proceeds.
// Matches the spec: "missing/acceptedAt/revokedAt/expired → throw exact msgs;
// email mismatch → throw; else valid".
//
// Checks are ordered by priority:
//   1. not_found (invite is null)
//   2. already_accepted
//   3. revoked
//   4. expired (expiresAt <= now — treat boundary as expired)
//   5. email_mismatch (case-insensitive comparison)
//   6. valid
// ---------------------------------------------------------------------------

export function inviteAcceptValidity(
  invite: InviteState | null,
  now: Date,
  callerEmail: string,
): InviteAcceptOutcome {
  if (!invite) return "not_found";
  if (invite.acceptedAt) return "already_accepted";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  if (invite.invitedEmail.toLowerCase() !== callerEmail.toLowerCase()) return "email_mismatch";
  return "valid";
}

// ---------------------------------------------------------------------------
// canDecide — grant state machine
//
// Allowed transitions (from spec decideCapability):
//   pending  → approved | denied
//   approved → revoked
//   denied   → (terminal — no transitions)
//   revoked  → (terminal — no transitions)
//
// Returns false for any transition not listed above.
// ---------------------------------------------------------------------------

export function canDecide(currentStatus: GrantStatus, decision: GrantDecision): boolean {
  if (currentStatus === "pending") {
    return decision === "approved" || decision === "denied";
  }
  if (currentStatus === "approved") {
    return decision === "revoked";
  }
  // denied and revoked are terminal
  return false;
}
