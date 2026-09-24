// Shared helpers for admin-org-verification use-cases.

import { and, eq, isNull } from "drizzle-orm";

import { type db, organizationMemberships } from "@/db";

// accountType check mirrors requireAdminOrRedirect (defense-in-depth: the
// role→accountType DB CHECK was dropped, so we enforce it here too).
export function isActiveInstitutionalAdmin(actor: {
  role: string | null;
  accountType: string | null;
  deactivatedAt: Date | null;
}): boolean {
  return (
    actor.role === "admin" && actor.accountType === "institutional" && actor.deactivatedAt === null
  );
}

// ---------------------------------------------------------------------------
// Helper: load the org admins' user IDs for notification fanout
// ---------------------------------------------------------------------------

export async function loadOrgAdminUserIds(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
): Promise<string[]> {
  const members = await tx
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.role, "admin"),
        isNull(organizationMemberships.leftAt),
      ),
    );
  return members.map((m) => m.userId);
}
