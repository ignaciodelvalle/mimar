// Pure role-hierarchy helpers for org membership.
// No DB imports, no Next.js imports — domain-only.
// Importers should use this module directly.
// Shim: app/actions/org-invitations.constants.ts re-exports ROLE_RANK,
//       INVITABLE_ROLES, and InvitableRole from here.

import type { OrganizationMembership } from "@/db/schema";

// ---------------------------------------------------------------------------
// Role rank — higher number = higher authority.
// Matches the rank table in the spec (admin5 coordinator4 member3
// vet_individual3 volunteer2 foster1).
// ---------------------------------------------------------------------------

export const ROLE_RANK: Record<OrganizationMembership["role"], number> = {
  admin: 5,
  coordinator: 4,
  member: 3,
  vet_individual: 3,
  volunteer: 2,
  foster: 1,
};

// ---------------------------------------------------------------------------
// Invitable roles — foster excluded (comes via foster-proposal flow).
// ---------------------------------------------------------------------------

const INVITABLE_ROLES_TUPLE = [
  "admin",
  "coordinator",
  "member",
  "volunteer",
  "vet_individual",
] as const;

export const INVITABLE_ROLES: typeof INVITABLE_ROLES_TUPLE = INVITABLE_ROLES_TUPLE;

export type InvitableRole = (typeof INVITABLE_ROLES_TUPLE)[number];

// ---------------------------------------------------------------------------
// Manager roles — admin + coordinator may manage coverage zones.
// ---------------------------------------------------------------------------

const MANAGER_ROLES = ["admin", "coordinator"] as const;

/** Returns true when the given membership role has manager-level access
 *  (i.e. is allowed to add/remove/set-primary coverage zones). */
export function isManagerRole(role: string): boolean {
  return (MANAGER_ROLES as readonly string[]).includes(role);
}

/** Returns true when `role` is a role that can be directly invited
 *  (i.e. excludes `foster` which comes via foster-proposal flow). */
export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Management predicates — used by removeMember, changeMemberRole, etc.
// ---------------------------------------------------------------------------

/** Returns true when `actorRole` can manage (remove/change-role of) `targetRole`.
 *  Blocked when targetRank >= actorRank (actor cannot manage same or higher rank). */
export function canManage(
  actorRole: OrganizationMembership["role"],
  targetRole: OrganizationMembership["role"],
): boolean {
  return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
}

/** Returns true when `actorRole` can assign `newRole` to another member.
 *  Blocked when newRoleRank > actorRank ("No podés asignar un rol mayor al tuyo"). */
export function canAssign(
  actorRole: OrganizationMembership["role"],
  newRole: OrganizationMembership["role"],
): boolean {
  return ROLE_RANK[newRole] <= ROLE_RANK[actorRole];
}
