// Use-case: accept an org invitation (authenticated user).
//
// Migrated from app/actions/org-invitations.ts::acceptInvitationAction.
// Auth (Supabase session check) handled by caller. Caller passes userId + userEmail.
//
// Rules (exact parity with original):
//   1. tx: SELECT invite FOR UPDATE by token.
//   2. Validate: not_found / accepted / revoked / expired / email_mismatch.
//   3. Fetch org.
//   4. Existing active membership → idempotent: mark accepted, return orgToken.
//   5. Insert membership + mark accepted. Queue inviter notification.
//   6. isUniqueViolation → "Ya sos miembro activo de esta organización."
//   7. Return { orgToken } + pending notifications (caller flushes post-tx).

import { inviteAcceptValidity } from "@/src/modules/organizations/domain/membership-state";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface for accept-invitation
// ---------------------------------------------------------------------------

export interface AcceptInvitationRepo {
  lockInviteByToken: OrgRepository["lockInviteByToken"];
  findOrgById: OrgRepository["findOrgById"];
  findExistingActiveMembership: OrgRepository["findExistingActiveMembership"];
  markInviteAccepted: OrgRepository["markInviteAccepted"];
  insertMembership: OrgRepository["insertMembership"];
  insertGrant: OrgRepository["insertGrant"];
  findAccepterDisplayName: OrgRepository["findAccepterDisplayName"];
  insertAuditLog: OrgRepository["insertAuditLog"];
}

// Roles that receive event.write implicitly via authz-resolver (no grant row needed).
const IMPLICIT_EVENT_WRITE_ROLES = new Set(["admin", "vet_individual"]);

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type AcceptInvitationInput = {
  invitationToken: string;
  userId: string;
  userEmail: string;
};

type Deps = {
  repo: AcceptInvitationRepo;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  isUniqueViolation: (err: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Error message map
// ---------------------------------------------------------------------------

const OUTCOME_MESSAGES: Record<string, string> = {
  not_found: "Invitación no encontrada.",
  already_accepted: "Esta invitación ya fue aceptada.",
  revoked: "Esta invitación fue revocada.",
  expired: "Esta invitación ya expiró.",
  email_mismatch:
    "Esta invitación no es para tu cuenta. Iniciá sesión con el email al que fue enviada.",
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function acceptInvitation(
  input: AcceptInvitationInput,
  deps: Deps,
): Promise<UseCaseResult<{ orgToken: string }>> {
  const { repo, transaction, isUniqueViolation } = deps;
  const pendingNotifications: NewNotification[] = [];

  let orgToken: string | null = null;

  try {
    await transaction(async (tx) => {
      const e = tx as Exec;
      // 1. Lock invite row FOR UPDATE.
      const invite = await repo.lockInviteByToken(input.invitationToken, e);

      // 2. Validate state.
      const outcome = inviteAcceptValidity(
        invite
          ? {
              acceptedAt: invite.acceptedAt,
              revokedAt: invite.revokedAt,
              expiresAt: invite.expiresAt,
              invitedEmail: invite.email,
            }
          : null,
        new Date(),
        input.userEmail,
      );

      if (outcome !== "valid") {
        throw new Error(OUTCOME_MESSAGES[outcome] ?? "Error de invitación.");
      }

      // invite is non-null here: inviteAcceptValidity returns "not_found" when null,
      // and we throw above for any outcome !== "valid". The check satisfies TS.
      if (!invite) throw new Error("Invitación no encontrada.");
      const validInvite = invite;

      // 3. Fetch org.
      const org = await repo.findOrgById(validInvite.organizationId, e);
      if (!org) throw new Error("Organización no encontrada.");

      // 4. Existing active membership → idempotent.
      const existingMembership = await repo.findExistingActiveMembership(
        validInvite.organizationId,
        input.userId,
        e,
      );
      if (existingMembership) {
        orgToken = org.publicToken;
        await repo.markInviteAccepted(validInvite.id, input.userId, e);
        return;
      }

      const now = new Date();

      // 5. Insert membership.
      const newMembershipId = await repo.insertMembership(
        {
          organizationId: validInvite.organizationId,
          userId: input.userId,
          role: validInvite.invitedRole,
          canWritePetEvents: validInvite.canWritePetEvents,
          invitedByUserId: validInvite.invitedByUserId,
          joinedAt: now,
        },
        e,
      );

      // 5a. Insert event.write capability grant for roles that don't get it implicitly.
      // Roles 'admin' and 'vet_individual' are resolved via implicit caps in authz-resolver;
      // a grant row for them would be redundant (though harmless). Skip to keep data clean.
      if (
        validInvite.canWritePetEvents &&
        !IMPLICIT_EVENT_WRITE_ROLES.has(validInvite.invitedRole)
      ) {
        await repo.insertGrant(
          {
            membershipId: newMembershipId,
            organizationId: validInvite.organizationId,
            capability: "event.write",
            status: "approved",
            decidedAt: now,
            decidedByUserId: validInvite.invitedByUserId ?? null,
            decisionReason: "invitation",
          },
          e,
        );
      }

      // Mark accepted.
      await repo.markInviteAccepted(validInvite.id, input.userId, e);

      // Audit: org_member_added via invitation accept.
      await repo.insertAuditLog(
        {
          actorUserId: input.userId,
          action: "org_member_added",
          targetUserId: input.userId,
          targetOrganizationId: validInvite.organizationId,
          payload: {
            org_id: validInvite.organizationId,
            member_user_id: input.userId,
            role: validInvite.invitedRole,
            how: "invitation_accept",
            invitation_id: validInvite.id,
          },
        },
        e,
      );

      orgToken = org.publicToken;

      // Queue inviter notification (post-tx).
      if (validInvite.invitedByUserId) {
        const accepterName = await repo.findAccepterDisplayName(input.userId, e);
        pendingNotifications.push({
          userId: validInvite.invitedByUserId,
          notificationType: "org_invitation_accepted",
          severity: "success",
          title: `${accepterName ?? "Un usuario"} aceptó tu invitación`,
          body: `Ahora es miembro de ${org.displayName} con el rol ${validInvite.invitedRole}.`,
          ctaLabel: "Ver miembros",
          ctaUrl: `/org/${org.publicToken}/miembros`,
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "Ya sos miembro activo de esta organización." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo aceptar la invitación.",
    };
  }

  if (!orgToken) return { ok: false, error: "Error inesperado al aceptar la invitación." };

  return { ok: true, value: { orgToken }, notifications: pendingNotifications };
}
