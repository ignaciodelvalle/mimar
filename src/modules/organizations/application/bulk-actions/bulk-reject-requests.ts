// bulk-reject-requests use-case (strangler 35/61).
// Whole-body verbatim move from app/actions/bulk-actions.ts — the reason
// pre-validation runs BEFORE the auth guard (and the validation fast-fail
// path skips revalidatePath), exactly as in the original. Writers are imported
// directly from their modules (not the action shims).

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { rejectRequestForAuthority } from "@/src/modules/organizations/application/admin-decisions/reject-request";

import type { BulkRejectInput, BulkResult } from "./types";

export async function bulkRejectRequests(input: BulkRejectInput): Promise<BulkResult> {
  const bulkActionId = randomUUID();
  const reason = input.reason.trim();
  if (reason.length < 5) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.requestPublicTokens.map((id) => ({
        id,
        reason: "El motivo del rechazo debe tener al menos 5 caracteres.",
      })),
    };
  }

  const session = await requireAdminOrGovtOrRedirect();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const token of input.requestPublicTokens) {
    try {
      const result = await rejectRequestForAuthority(session.user.id, token, reason, bulkActionId);
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
  return { bulkActionId, succeeded, failed };
}
