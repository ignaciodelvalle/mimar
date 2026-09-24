"use server";

// admin-decisions.ts — thin shim (strangler migration 17/61).
//
// Business logic moved to:
//   src/modules/organizations/application/admin-decisions/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The ForAuthority writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied actorUserId would let any client act as any authority.
// Callers (bulk-actions, seed scripts, tests) import the writers from
// src/modules/organizations/application/admin-decisions/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath, revalidateTag } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { approveRequestForAuthority as _approveRequest } from "@/src/modules/organizations/application/admin-decisions/approve-request";
import { rejectRequestForAuthority as _rejectRequest } from "@/src/modules/organizations/application/admin-decisions/reject-request";
import { requestInfoForAuthority as _requestInfo } from "@/src/modules/organizations/application/admin-decisions/request-info";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { DecisionResult } from "@/src/modules/organizations/application/admin-decisions/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function approveRequestAction(publicToken: string, notes: string | null) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _approveRequest(user.id, publicToken, notes);
  if ("ok" in result) {
    revalidatePath("/gob/cola");
    revalidatePath(`/gob/cola/${publicToken}`);
    revalidatePath("/admin/cola");
    revalidatePath(`/admin/cola/${publicToken}`);
    // An approval can flip an org to verified — the public /refugios directory
    // (Data Cache, tag "org-directory") must not serve the stale roster for
    // its full 300s window.
    revalidateTag("org-directory");
  }
  return result;
}

export async function rejectRequestAction(publicToken: string, reason: string) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _rejectRequest(user.id, publicToken, reason);
  if ("ok" in result) {
    revalidatePath("/gob/cola");
    revalidatePath(`/gob/cola/${publicToken}`);
    revalidatePath("/admin/cola");
    revalidatePath(`/admin/cola/${publicToken}`);
  }
  return result;
}

/**
 * "Pedir más información" — NON-terminal (UI/UX audit 2026-07). Records a
 * notes-only info-request event + applicant notification; the request stays
 * pending and decidable. No revalidate of the queue lists is needed (nothing
 * about the row's queue presence changes), but the detail pages re-render so
 * the operator sees the confirmation state.
 */
export async function requestInfoAction(publicToken: string, message: string) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _requestInfo(user.id, publicToken, message);
  if ("ok" in result) {
    revalidatePath(`/gob/cola/${publicToken}`);
    revalidatePath(`/admin/cola/${publicToken}`);
  }
  return result;
}
