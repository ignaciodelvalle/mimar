// Use-case: self-leave from an organization.
//
// Migrated from app/actions/org-memberships.ts::leaveOrganizationAction.
// Auth (Supabase session check + user guard) handled by caller.
//
// Rules (exact parity with original):
//   1. Find caller's own active membership.
//   2. role=admin: tx + FOR UPDATE lock; last-admin guard; soft-delete + audit.
//   3. Non-admin: soft-delete + audit in one tx.

import { lastAdminBlocks } from "@/src/modules/organizations/domain/membership-state";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Extended repo interface — findOwnActiveMembership needed for self-leave
// ---------------------------------------------------------------------------

export interface LeaveOrganizationRepo
  extends Pick<OrgRepository, "lockActiveAdmins" | "softLeave" | "insertAuditLog"> {
  findOwnActiveMembership(
    userId: string,
    organizationId: string,
  ): Promise<{
    id: string;
    role: string;
    userId: string;
  } | null>;
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type LeaveOrganizationInput = {
  userId: string;
  organizationId: string;
  organization: {
    publicToken: string;
  };
};

type Deps = {
  repo: LeaveOrganizationRepo;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function leaveOrganization(
  input: LeaveOrganizationInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction } = deps;

  // 1. Find caller's own active membership.
  const membership = await repo.findOwnActiveMembership(input.userId, input.organizationId);
  if (!membership) return { ok: false, error: "No sos miembro activo de esta organización." };

  if (membership.role === "admin") {
    // 2. Admin self-leave: enforce last-admin protection atomically.
    let lastAdminError: string | null = null;
    try {
      await transaction(async (tx) => {
        const e = tx as Exec;
        const adminRows = await repo.lockActiveAdmins(input.organizationId, e);

        if (lastAdminBlocks(adminRows.length)) {
          lastAdminError =
            "No podés salir porque sos el único administrador. Asigná otro administrador primero.";
          throw new Error("LAST_ADMIN");
        }

        await repo.softLeave(membership.id, e);
        await repo.insertAuditLog(
          {
            actorUserId: input.userId,
            action: "org_member_removed",
            targetUserId: input.userId,
            targetOrganizationId: input.organizationId,
            payload: {
              org_id: input.organizationId,
              member_user_id: input.userId,
              role: membership.role,
              how: "self_leave",
            },
          },
          e,
        );
      });
    } catch (e) {
      if (lastAdminError) return { ok: false, error: lastAdminError };
      throw e;
    }
  } else {
    // 3. Non-admin: soft-delete + audit in one tx.
    await transaction(async (tx) => {
      const e = tx as Exec;
      await repo.softLeave(membership.id, e);
      await repo.insertAuditLog(
        {
          actorUserId: input.userId,
          action: "org_member_removed",
          targetUserId: input.userId,
          targetOrganizationId: input.organizationId,
          payload: {
            org_id: input.organizationId,
            member_user_id: input.userId,
            role: membership.role,
            how: "self_leave",
          },
        },
        e,
      );
    });
  }

  return { ok: true, value: undefined, notifications: [] };
}
