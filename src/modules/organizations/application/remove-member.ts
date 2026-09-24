// Use-case: remove an org member (admin action).
//
// Migrated from app/actions/org-memberships.ts::removeMemberAction.
// Auth (requireCapability("member.invite", organizationId)) handled by caller.
//
// Rules (exact parity with original):
//   1. Load target membership (org-scoped WHERE).
//   2. For admin targets: enter tx + FOR UPDATE lock.
//   3. LAST-ADMIN check FIRST (highest-priority invariant).
//   4. Self-check.
//   5. Rank rule.
//   6. Soft-delete + audit_log (same tx).
//   7. Best-effort notification (queued — caller flushes post-tx).

import { lastAdminBlocks } from "@/src/modules/organizations/domain/membership-state";
import { ROLE_RANK } from "@/src/modules/organizations/domain/role-rules";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type RemoveMemberInput = {
  organizationId: string;
  membershipId: string;
  actor: {
    userId: string;
    role: string;
    membershipId: string;
  };
  organization: {
    publicToken: string;
    displayName: string;
  };
};

type RepoDeps = Pick<
  OrgRepository,
  "findActiveMembership" | "lockActiveAdmins" | "softLeave" | "insertAuditLog"
>;

type Deps = {
  repo: RepoDeps;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function removeMember(
  input: RemoveMemberInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction } = deps;
  const pendingNotifications: NewNotification[] = [];

  // 1. Load target (org-scoped — findActiveMembership uses orgId + membershipId).
  const target = await repo.findActiveMembership(input.organizationId, input.membershipId);
  if (!target) return { ok: false, error: "Membresía no encontrada o ya inactiva." };

  const actorRank = ROLE_RANK[input.actor.role as keyof typeof ROLE_RANK] ?? 0;
  const targetRank = ROLE_RANK[target.role] ?? 0;

  if (target.role === "admin") {
    // 2. Admin target: tx + FOR UPDATE lock.
    let actionError: string | null = null;
    try {
      await transaction(async (tx) => {
        const e = tx as Exec;
        const adminRows = await repo.lockActiveAdmins(input.organizationId, e);

        // 3. Last-admin check FIRST (highest-priority invariant).
        if (lastAdminBlocks(adminRows.length)) {
          actionError = "La organización debe tener al menos un administrador.";
          throw new Error("LAST_ADMIN");
        }

        // 4. Self-check.
        if (target.userId === input.actor.userId) {
          actionError =
            "No podés quitarte a vos mismo por esta vía. Usá la opción 'Salir de la organización'.";
          throw new Error("SELF");
        }

        // 5. Rank rule.
        if (targetRank > actorRank) {
          actionError = "No podés gestionar a alguien con un rol mayor al tuyo.";
          throw new Error("RANK");
        }

        // 6. Soft-delete + audit (same tx).
        await repo.softLeave(input.membershipId, e);
        await repo.insertAuditLog(
          {
            actorUserId: input.actor.userId,
            action: "org_member_removed",
            targetUserId: target.userId,
            targetOrganizationId: input.organizationId,
            payload: {
              org_id: input.organizationId,
              member_user_id: target.userId,
              role: target.role,
              how: "admin_remove",
            },
          },
          e,
        );
      });
    } catch (e) {
      if (actionError) return { ok: false, error: actionError };
      throw e;
    }
  } else {
    // Non-admin target: no last-admin concern.

    // 4. Self-check.
    if (target.userId === input.actor.userId) {
      return {
        ok: false,
        error:
          "No podés quitarte a vos mismo por esta vía. Usá la opción 'Salir de la organización'.",
      };
    }

    // 5. Rank rule.
    if (targetRank > actorRank) {
      return { ok: false, error: "No podés gestionar a alguien con un rol mayor al tuyo." };
    }

    // 6. Soft-delete + audit in one tx (atomicity).
    await transaction(async (tx) => {
      const e = tx as Exec;
      await repo.softLeave(input.membershipId, e);
      await repo.insertAuditLog(
        {
          actorUserId: input.actor.userId,
          action: "org_member_removed",
          targetUserId: target.userId,
          targetOrganizationId: input.organizationId,
          payload: {
            org_id: input.organizationId,
            member_user_id: target.userId,
            role: target.role,
            how: "admin_remove",
          },
        },
        e,
      );
    });
  }

  // 7. Best-effort notification (caller flushes post-tx).
  // The removed member can no longer access /org/* pages, so the CTA points at
  // their own account surface, not the organization.
  pendingNotifications.push({
    userId: target.userId,
    notificationType: "org_membership_removed",
    severity: "info",
    title: `Fuiste quitado de ${input.organization.displayName}`,
    body: `Tu membresía en ${input.organization.displayName} fue finalizada por un administrador.`,
    ctaLabel: "Ver mi cuenta",
    ctaUrl: "/cuenta",
  });

  return { ok: true, value: undefined, notifications: pendingNotifications };
}
