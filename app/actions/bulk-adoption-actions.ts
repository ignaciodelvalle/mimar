"use server";

// bulk-adoption-actions.ts — thin shim (strangler migration 41/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/adoption/application/bulk-adoption-actions/
//
// The auth guard (requireOrgAccessByToken) is lifted into these wrappers so
// the shim satisfies the authz-coverage convention. The use-cases handle
// validation + per-item loops.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { bulkApproveAdoptionApplications } from "@/src/modules/adoption/application/bulk-adoption-actions/bulk-approve-adoption-applications";
import { bulkRejectAdoptionApplications } from "@/src/modules/adoption/application/bulk-adoption-actions/bulk-reject-adoption-applications";
import type {
  BulkAdoptionApproveInput,
  BulkAdoptionRejectInput,
} from "@/src/modules/adoption/application/bulk-adoption-actions/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  BulkAdoptionApproveInput,
  BulkAdoptionRejectInput,
} from "@/src/modules/adoption/application/bulk-adoption-actions/types";

// ---------------------------------------------------------------------------
// Action wrappers — auth lifted from use-cases into the shim wrappers
// ---------------------------------------------------------------------------

export async function bulkApproveAdoptionApplicationsAction(input: BulkAdoptionApproveInput) {
  await requireOrgAccessByToken(input.orgToken);
  return bulkApproveAdoptionApplications(input);
}

export async function bulkRejectAdoptionApplicationsAction(input: BulkAdoptionRejectInput) {
  await requireOrgAccessByToken(input.orgToken);
  return bulkRejectAdoptionApplications(input);
}
