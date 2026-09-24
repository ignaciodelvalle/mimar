"use server";

// approval-requests.ts — thin shim (strangler migration 49/61).
//
// Business logic moved to:
//   src/modules/organizations/application/approval-requests/
//
// This file provides withdrawApprovalRequestAction (outer auth-guarded server
// action used by UI components). The inner writer lives in the application
// module and is deliberately NOT exported from this "use server" file —
// exporting it would make it an independently-addressable server action that
// accepts an attacker-supplied userId (authz triage 2026-07-04).
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import type { WithdrawApprovalRequestResult } from "@/src/modules/organizations/application/approval-requests/types";
import { withdrawApprovalRequestForUser as _withdrawApprovalRequestForUser } from "@/src/modules/organizations/application/approval-requests/withdraw-approval-request";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { WithdrawApprovalRequestResult } from "@/src/modules/organizations/application/approval-requests/types";

// ---------------------------------------------------------------------------
// Public wrapper: withdrawApprovalRequestAction
// ---------------------------------------------------------------------------

export async function withdrawApprovalRequestAction(
  requestId: string,
): Promise<WithdrawApprovalRequestResult> {
  const { user } = await requireUserOrRedirect();
  const result = await _withdrawApprovalRequestForUser(user.id, requestId);
  if ("ok" in result) {
    revalidatePath("/cuenta/solicitudes");
  }
  return result;
}
