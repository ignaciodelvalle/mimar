"use server";

// bulk-actions.ts — thin shim (strangler migration 35/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/organizations/application/bulk-actions/
//
// The auth guard, pre-validation order, and revalidatePath calls live INSIDE
// the use-cases (preserving the original control flow exactly — validation
// before auth for reject/revoke), so these wrappers are pure delegations.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { bulkApproveRequests } from "@/src/modules/organizations/application/bulk-actions/bulk-approve-requests";
import { bulkRejectRequests } from "@/src/modules/organizations/application/bulk-actions/bulk-reject-requests";
import { bulkRevoke } from "@/src/modules/organizations/application/bulk-actions/bulk-revoke";
import type {
  BulkApproveInput,
  BulkRejectInput,
  BulkResult,
  BulkRevokeInput,
} from "@/src/modules/organizations/application/bulk-actions/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  BulkResult,
  BulkApproveInput,
  BulkRejectInput,
  BulkRevokeKind,
  BulkRevokeInput,
} from "@/src/modules/organizations/application/bulk-actions/types";

// ---------------------------------------------------------------------------
// Action wrappers
// ---------------------------------------------------------------------------

export async function bulkApproveRequestsAction(input: BulkApproveInput): Promise<BulkResult> {
  const { user } = await requireAdminOrGovtOrRedirect();
  return bulkApproveRequests(user.id, input);
}

// @no-auth-required: auth enforced inside the delegated use-case
// (requireAdminOrGovtOrRedirect runs after reason-length validation that must
// precede it — lifting would reorder the validation-before-auth control flow).
export async function bulkRejectRequestsAction(input: BulkRejectInput): Promise<BulkResult> {
  return bulkRejectRequests(input);
}

// @no-auth-required: auth enforced inside the delegated use-case
// (requireAdminOrGovtOrRedirect runs after motivo + attachments validation that
// must precede it — lifting would reorder the validation-before-auth control flow).
export async function bulkRevokeAction(input: BulkRevokeInput): Promise<BulkResult> {
  return bulkRevoke(input);
}
