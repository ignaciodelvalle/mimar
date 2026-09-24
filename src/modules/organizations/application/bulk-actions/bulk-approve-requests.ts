// bulk-approve-requests use-case (strangler 35/61).
// Whole-body verbatim move from app/actions/bulk-actions.ts — auth guard,
// per-item loop, and revalidatePath calls preserved in the original order.
// Writers are imported directly from their modules (not the action shims).

import { randomUUID } from "node:crypto";

import { revalidatePath, revalidateTag } from "next/cache";

import { approveRequestForAuthority } from "@/src/modules/organizations/application/admin-decisions/approve-request";

import type { BulkApproveInput, BulkResult } from "./types";

export async function bulkApproveRequests(
  actorUserId: string,
  input: BulkApproveInput,
): Promise<BulkResult> {
  const bulkActionId = randomUUID();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const token of input.requestPublicTokens) {
    try {
      const result = await approveRequestForAuthority(
        actorUserId,
        token,
        input.decisionNotes?.trim() || null,
        bulkActionId,
      );
      if ("error" in result) {
        failed.push({ id: token, reason: result.error });
      } else {
        succeeded.push(token);
      }
    } catch (err) {
      failed.push({ id: token, reason: err instanceof Error ? err.message : "unknown_error" });
    }
  }

  revalidatePath("/admin/cola");
  revalidatePath("/gob/cola");
  // Approvals can flip orgs to verified — drop the public /refugios directory
  // cache (tag "org-directory") rather than serving the stale roster for 300s.
  revalidateTag("org-directory");
  return { bulkActionId, succeeded, failed };
}
