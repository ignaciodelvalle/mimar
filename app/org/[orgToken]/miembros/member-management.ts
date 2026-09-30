// Helpers for org member management UI — rank-bounded role options.
// Kept separate from page.tsx (which may only export the default component
// + allowed Next.js page fields).

import type { OrganizationMembership } from "@/db";
import {
  INVITABLE_ROLES,
  ROLE_RANK,
  roleAppliesToOrgType,
} from "@/src/modules/organizations/domain/role-rules";

export const ROLE_LABEL: Record<OrganizationMembership["role"], string> = {
  admin: "Administrador",
  coordinator: "Coordinador",
  member: "Miembro",
  volunteer: "Voluntario",
  vet_individual: "Veterinario",
  foster: "Tránsito",
};

export type SettableRole = { value: string; label: string };

/**
 * Returns the roles the actor can assign to another member — or invite one
 * as — bounded by the actor's own rank (cannot promote above yourself) and by
 * the org's type: coordinator and volunteer exist only in a rehoming org
 * (roleAppliesToOrgType, portal-vet-p0 D13). The invite page and the role
 * selector both read this ONE list, in INVITABLE_ROLES order.
 */
export function getSettableRoles(
  actorRole: OrganizationMembership["role"],
  orgType: string,
): SettableRole[] {
  const actorRank = ROLE_RANK[actorRole];
  return INVITABLE_ROLES.filter(
    (r) => ROLE_RANK[r] <= actorRank && roleAppliesToOrgType(r, orgType),
  ).map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
  }));
}

/**
 * Returns true when the actor (identified by role) can manage the target
 * (by rank rule). Does NOT check self (caller must handle self separately).
 */
export function canActorManage(
  actorRole: OrganizationMembership["role"],
  targetRole: OrganizationMembership["role"],
): boolean {
  return ROLE_RANK[targetRole] <= ROLE_RANK[actorRole];
}
