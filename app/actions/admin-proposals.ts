"use server";

// admin-proposals.ts — thin shim (strangler migration 20/61).
//
// Business logic moved to:
//   src/modules/organizations/application/admin-proposals/
//
// This file provides thin Action wrappers (proposeVetUpgradeAction,
// proposeOrgVerificationAction). The bare writers (logPiiReadSafely,
// proposeVetUpgradeForUser, proposeOrgVerificationForOrg) are NOT exported
// here (authz triage 2026-07-04; logPiiReadSafely added review 07,
// 2026-07-05): every export of a "use server" file is an independently-
// addressable server action, so a bare writer taking a caller-supplied
// actorUserId would allow PII-audit forgery / proposal spam as any user —
// being called only from an already-gated /gob page is NOT a backstop, since
// the export bypasses the page entirely. The server-component list pages
// import logPiiReadSafely from
// src/modules/organizations/application/admin-proposals/log-pii-query directly
// (PII audit logging has no client-callable action — it is only ever invoked
// server-side from those pages).
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { proposeOrgVerificationForOrg as _proposeOrgVerificationForOrg } from "@/src/modules/organizations/application/admin-proposals/propose-org-verification";
import { proposeVetUpgradeForUser as _proposeVetUpgradeForUser } from "@/src/modules/organizations/application/admin-proposals/propose-vet-upgrade";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { ProposalResult } from "@/src/modules/organizations/application/admin-proposals/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function proposeVetUpgradeAction(
  input: Parameters<typeof _proposeVetUpgradeForUser>[1],
) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _proposeVetUpgradeForUser(user.id, input);
  if ("ok" in result) {
    // Cola/Usuarios are dual-portal surfaces (portal-follows-viewer,
    // 2026-07-02): /admin/cola is a thin wrapper re-exporting the gob page;
    // Usuarios is the Directorio hub's "usuarios" tab in BOTH portals
    // (F3+F7 fusion, 2026-07-22) — revalidate all four routes.
    revalidatePath("/gob/cola");
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/cola");
    revalidatePath("/admin/directorio");
  }
  return result;
}

export async function proposeOrgVerificationAction(
  input: Parameters<typeof _proposeOrgVerificationForOrg>[1],
) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _proposeOrgVerificationForOrg(user.id, input);
  if ("ok" in result) {
    // Cola/Organizaciones are dual-portal surfaces (portal-follows-viewer,
    // 2026-07-02): /admin/cola is a thin wrapper re-exporting the gob page;
    // Organizaciones is the Directorio hub's "organizaciones" tab in BOTH
    // portals (F3+F7 fusion, 2026-07-22) — revalidate all four routes.
    revalidatePath("/gob/cola");
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/cola");
    revalidatePath("/admin/directorio");
  }
  return result;
}
