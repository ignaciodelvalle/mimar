// Use-case: revoke an org invitation.
//
// Migrated from app/actions/org-invitations.ts::revokeInvitationAction.
// Auth (requireCapability("member.invite", organizationId)) handled by caller.
//
// Rules (exact parity with original):
//   1. Load invite by token + org.
//   2. missing → error.
//   3. acceptedAt OR revokedAt → idempotent ok.
//   4. Else set revokedAt.

import type { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Extended repo interface — needs findInviteByToken for org-scoped lookup
// ---------------------------------------------------------------------------

export interface RevokeInvitationRepo {
  findInviteByToken(token: string): Promise<{
    id: string;
    organizationId: string;
    acceptedAt: Date | null;
    revokedAt: Date | null;
  } | null>;
  setInviteRevoked: OrgRepository["setInviteRevoked"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type RevokeInvitationInput = {
  organizationId: string;
  invitationToken: string;
  organization: {
    publicToken: string;
  };
};

type Deps = {
  repo: RevokeInvitationRepo;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  input: RevokeInvitationInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo } = deps;

  const invite = await repo.findInviteByToken(input.invitationToken);

  // Org-scoped check: the invite must belong to this org.
  if (!invite || invite.organizationId !== input.organizationId) {
    return { ok: false, error: "Invitación no encontrada." };
  }

  // Idempotent: already accepted or revoked.
  if (invite.acceptedAt || invite.revokedAt) {
    return { ok: true, value: undefined, notifications: [] };
  }

  await repo.setInviteRevoked(invite.id);

  return { ok: true, value: undefined, notifications: [] };
}
