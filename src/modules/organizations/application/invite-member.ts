// Use-case: invite a member to an organization.
//
// Migrated from app/actions/org-invitations.ts::inviteMemberAction.
// Auth (requireCapability("member.invite", organizationId)) handled by caller.
//
// Rules (exact parity with original):
//   1. Validate invitedRole ∈ INVITABLE_ROLES.
//   2. targetRank ≤ inviterRank (can't invite to higher role).
//   3. Normalize + validate email (must contain @).
//   4. Check existing active invite: if expired → auto-revoke; if active → block.
//   5. Generate unique token (caller provides generator fn).
//   6. Insert invitation.
//   7. Notify org admins (best-effort — queued for post-tx flush).
//   8. Return inviteUrl.

import { resolveSiteUrl } from "@/lib/infra/site-url";
import {
  INVITABLE_ROLES,
  type InvitableRole,
  ROLE_RANK,
} from "@/src/modules/organizations/domain/role-rules";
import type { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type InviteMemberInput = {
  organizationId: string;
  email: string;
  invitedRole: string;
  canWritePetEvents?: boolean;
  actor: {
    userId: string;
    role: string;
    membershipId: string;
  };
  organization: {
    id: string;
    publicToken: string;
    displayName: string;
  };
  /** Caller provides token generator (real: generateUniqueToken; test: vi.fn()) */
  generateToken: () => Promise<string>;
  /** Override NEXT_PUBLIC_SITE_URL for tests */
  appBase?: string;
};

type RepoDeps = Pick<
  OrgRepository,
  "findActiveInvite" | "setInviteRevoked" | "insertInvite" | "adminRecipients"
>;

type Deps = {
  repo: RepoDeps;
  isUniqueViolation: (err: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function inviteMember(
  input: InviteMemberInput,
  deps: Deps,
): Promise<UseCaseResult<{ inviteUrl: string }>> {
  const { repo, isUniqueViolation } = deps;
  const pendingNotifications: NewNotification[] = [];

  // 1. Validate invitedRole.
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.invitedRole)) {
    return {
      ok: false,
      error: `Rol inválido. Los roles invitables son: ${INVITABLE_ROLES.join(", ")}.`,
    };
  }

  // 2. Role-rank bound.
  const inviterRank = ROLE_RANK[input.actor.role as keyof typeof ROLE_RANK] ?? 0;
  const targetRank = ROLE_RANK[input.invitedRole as keyof typeof ROLE_RANK] ?? 0;
  if (targetRank > inviterRank) {
    return { ok: false, error: "No podés invitar a alguien con un rol mayor al tuyo." };
  }

  // 3. Normalize + validate email.
  const normalizedEmail = input.email.toLowerCase().trim();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { ok: false, error: "Email inválido." };
  }

  // 4. Check existing active invite.
  const now = new Date();
  const existingInvite = await repo.findActiveInvite(input.organization.id, normalizedEmail);
  if (existingInvite) {
    if (existingInvite.expiresAt <= now) {
      // Expired but not revoked — auto-revoke so the partial unique index allows re-invite.
      await repo.setInviteRevoked(existingInvite.id);
    } else {
      return {
        ok: false,
        error:
          "Ya existe una invitación activa para ese email en esta organización. Revocarla primero para re-invitar.",
      };
    }
  }

  // 5. Generate unique token.
  let token: string;
  try {
    token = await input.generateToken();
  } catch {
    return { ok: false, error: "No se pudo generar el token de invitación. Intentá de nuevo." };
  }

  // 6. Insert invitation.
  try {
    await repo.insertInvite({
      organizationId: input.organization.id,
      invitedByUserId: input.actor.userId,
      email: normalizedEmail,
      invitedRole: input.invitedRole as InvitableRole,
      canWritePetEvents: input.canWritePetEvents ?? false,
      invitationToken: token,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: "Ya existe una invitación activa para ese email en esta organización.",
      };
    }
    return {
      ok: false,
      error: `No se pudo crear la invitación: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // 7. Notify org admins (best-effort — caller flushes post-tx).
  try {
    const admins = await repo.adminRecipients(input.organization.id);
    const notifyIds = new Set<string>(admins.map((r) => r.userId));
    for (const uid of notifyIds) {
      pendingNotifications.push({
        userId: uid,
        notificationType: "org_invitation_created",
        severity: "warning",
        title: `Nueva invitación enviada en ${input.organization.displayName}`,
        body: `Se invitó a ${normalizedEmail} con el rol ${input.invitedRole}.`,
        ctaLabel: "Ver miembros",
        ctaUrl: `/org/${input.organization.publicToken}/miembros`,
      });
    }
  } catch (e) {
    console.error("adminRecipients query failed (inviteMember did succeed)", e);
  }

  // 8. Build invite URL.
  const appBase = input.appBase ?? resolveSiteUrl();
  const inviteUrl = `${appBase}/r/invite/${token}`;

  return { ok: true, value: { inviteUrl }, notifications: pendingNotifications };
}
