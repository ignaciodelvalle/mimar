// bulk-reject-adoption-applications use-case (strangler 41/61, 2026-06-30).
// Whole-body verbatim move from app/actions/bulk-adoption-actions.ts — auth FIRST,
// then reason-length validation, then loop (original order preserved exactly).

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { rejectAdoptionApplicationAction } from "@/src/modules/adoption/actions";
import type { BulkResult } from "@/src/modules/organizations/application/bulk-actions/types";

import type { BulkAdoptionRejectInput } from "./types";

export async function bulkRejectAdoptionApplications(
  input: BulkAdoptionRejectInput,
): Promise<BulkResult> {
  // Auth guard (requireOrgAccessByToken) is now called by the shim wrapper
  // before delegating here. Per-item authorization ("adoption.review" capability
  // + org ownership) is still enforced inside rejectAdoptionApplicationAction.
  const bulkActionId = randomUUID();
  const reason = input.reason.trim();

  // Validate reason before touching any item — fail-fast so the org reviewer
  // sees one clear error rather than N copies of the same validation message.
  if (reason.length < 5) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.applicationEventIds.map((id) => ({
        id,
        reason: "El motivo del rechazo debe tener al menos 5 caracteres.",
      })),
    };
  }

  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const applicationEventId of input.applicationEventIds) {
    try {
      const result = await rejectAdoptionApplicationAction(input.orgToken, {
        applicationEventId,
        notes: reason,
      });
      if ("error" in result) {
        failed.push({ id: applicationEventId, reason: result.error });
      } else {
        succeeded.push(applicationEventId);
      }
    } catch (err) {
      failed.push({
        id: applicationEventId,
        reason: err instanceof Error ? err.message : "unknown_error",
      });
    }
  }

  revalidatePath(`/org/${input.orgToken}/adopciones`);
  return { bulkActionId, succeeded, failed };
}
