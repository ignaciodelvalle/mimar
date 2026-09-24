// Use-case: change the role of an org member (admin action).
//
// Migrated from app/actions/org-memberships.ts::changeMemberRoleAction.
// Auth (requireCapability("member.invite", organizationId)) handled by caller.
//
// Rules (exact parity with original):
//   1. Validate newRole ∈ INVITABLE_ROLES.
//   2. Validate newRoleRank ≤ actorRank (can't assign higher role).
//   3. Load target membership.
//   4. For admin demotion: tx + FOR UPDATE lock.
//   5. LAST-ADMIN check FIRST.
//   6. Self-check.
//   7. Rank rule on target's CURRENT role.
//   8. setRole + audit_log (same tx).

import { lastAdminBlocks } from "@/src/modules/organizations/domain/membership-state";
import { INVITABLE_ROLES, ROLE_RANK } from "@/src/modules/organizations/domain/role-rules";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type ChangeOrganizationMemberRoleInput = {
  organizationId: string;
  membershipId: string;
  newRole: string;
  actor: {
    userId: string;
    role: string;
    membershipId: string;
  };
  organization: {
    publicToken: string;
  };
};

type RepoDeps = Pick<
  OrgRepository,
  "findActiveMembership" | "lockActiveAdmins" | "setRole" | "insertAuditLog"
>;

type Deps = {
  repo: RepoDeps;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function changeOrganizationMemberRole(
  input: ChangeOrganizationMemberRoleInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction } = deps;

  // 1. Validate newRole.
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.newRole)) {
    return {
      ok: false,
      error: `Rol inválido. Los roles configurables son: ${INVITABLE_ROLES.join(", ")}.`,
    };
  }

  const actorRank = ROLE_RANK[input.actor.role as keyof typeof ROLE_RANK] ?? 0;
  const newRoleRank = ROLE_RANK[input.newRole as keyof typeof ROLE_RANK] ?? 0;

  // 2. Can't promote above own rank.
  if (newRoleRank > actorRank) {
    return { ok: false, error: "No podés asignar un rol mayor al tuyo." };
  }

  // 3. Load target.
  const target = await repo.findActiveMembership(input.organizationId, input.membershipId);
  if (!target) return { ok: false, error: "Membresía no encontrada o ya inactiva." };

  const targetRank = ROLE_RANK[target.role] ?? 0;

  if (target.role === "admin" && input.newRole !== "admin") {
    // 4. Admin demotion: tx + FOR UPDATE lock.
    let actionError: string | null = null;
    try {
      await transaction(async (tx) => {
        const e = tx as Exec;
        const adminRows = await repo.lockActiveAdmins(input.organizationId, e);

        // 5. Last-admin check FIRST.
        if (lastAdminBlocks(adminRows.length)) {
          actionError = "La organización debe tener al menos un administrador.";
          throw new Error("LAST_ADMIN");
        }

        // 6. Self-check.
        if (target.userId === input.actor.userId) {
          actionError = "No podés cambiar tu propio rol.";
          throw new Error("SELF");
        }

        // 7. Rank rule on target's current role.
        if (targetRank > actorRank) {
          actionError = "No podés gestionar a alguien con un rol mayor al tuyo.";
          throw new Error("RANK");
        }

        // 8. Update role + audit (same tx).
        await repo.setRole(
          input.membershipId,
          input.newRole as Parameters<typeof repo.setRole>[1],
          e,
        );
        await repo.insertAuditLog(
          {
            actorUserId: input.actor.userId,
            action: "org_member_role_changed",
            targetUserId: target.userId,
            targetOrganizationId: input.organizationId,
            payload: {
              org_id: input.organizationId,
              member_user_id: target.userId,
              role_before: target.role,
              role_after: input.newRole,
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
    // No last-admin concern.

    // 6. Self-check.
    if (target.userId === input.actor.userId) {
      return { ok: false, error: "No podés cambiar tu propio rol." };
    }

    // 7. Rank rule on target's current role.
    if (targetRank > actorRank) {
      return { ok: false, error: "No podés gestionar a alguien con un rol mayor al tuyo." };
    }

    // 8. Update role + audit in one tx.
    await transaction(async (tx) => {
      const e = tx as Exec;
      await repo.setRole(
        input.membershipId,
        input.newRole as Parameters<typeof repo.setRole>[1],
        e,
      );
      await repo.insertAuditLog(
        {
          actorUserId: input.actor.userId,
          action: "org_member_role_changed",
          targetUserId: target.userId,
          targetOrganizationId: input.organizationId,
          payload: {
            org_id: input.organizationId,
            member_user_id: target.userId,
            role_before: target.role,
            role_after: input.newRole,
          },
        },
        e,
      );
    });
  }

  return { ok: true, value: undefined, notifications: [] };
}
