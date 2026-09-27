"use server";

// govt-reactivation.ts — the platform admin's reversal of a funcionario's
// deactivation (jurisdiction-admin, admin-reversal), for /admin/govts/[userId].
//
// PLATFORM-ONLY, BOTH GUARDS: requireAdminOrRedirect here, requirePlatformAdmin
// inside the writer's transaction (and the audit_log guard below both). A
// jurisdiction admin deactivates inside their province; only the platform admin
// reactivates. Kept apart from ./admin-institutional.ts, whose shared acts a
// jurisdiction admin may call, so the file says what it is. Inventory pinned by
// scripts/check-admin-authority.ts.
//
// The writer is NOT exported here (a "use server" export taking a
// caller-supplied actor id would impersonate anyone).

import { revalidatePath } from "next/cache";

import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { reactivateGovtForAuthority } from "@/src/modules/organizations/application/admin-institutional/reactivate-govt";

/** Switch a deactivated govt (or national observer) back on. Localities are NOT restored. */
export async function reactivateGovtAction(input: { targetGovtUserId: string; reason: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await reactivateGovtForAuthority(user.id, input);
  if ("ok" in result) {
    revalidatePath("/admin/govts");
    revalidatePath(`/admin/govts/${input.targetGovtUserId}`);
    revalidatePath("/gob/administracion/funcionarios");
  }
  return result;
}
