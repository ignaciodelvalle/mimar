"use server";

// admin-revocations.ts — thin shim (strangler migration 8/61).
//
// Business logic moved to:
//   src/modules/organizations/application/revocations/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The ForAuthority writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied actorUserId would let any client act as any authority.
// Callers import the writers from
// src/modules/organizations/application/revocations/ directly.
//
// claimAttachmentsForAudit: authoritative source is now revocations/helpers.ts.
// admin-institutional/deactivate-admin and deactivate-govt import directly
// from the module — the back-edge is closed.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath, revalidateTag } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { claimAttachmentsForAudit as _claimAttachments } from "@/src/modules/organizations/application/revocations/helpers";
import { revokeGovtLocalityForAuthority as _revokeGovtLocality } from "@/src/modules/organizations/application/revocations/revoke-govt-locality";
import { revokeOrgVerificationForAuthority as _revokeOrgVerification } from "@/src/modules/organizations/application/revocations/revoke-org-verification";
import { revokeVetRoleForAuthority as _revokeVetRole } from "@/src/modules/organizations/application/revocations/revoke-vet-role";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { RevocationResult } from "@/src/modules/organizations/application/revocations/types";

// ---------------------------------------------------------------------------
// Utility re-export — preserved for any callers (bulk-actions, tests).
// Authoritative source: revocations/helpers.ts (ADR-5).
// ---------------------------------------------------------------------------

export async function claimAttachmentsForAudit(
  ...args: Parameters<typeof _claimAttachments>
): Promise<void> {
  return _claimAttachments(...args);
}

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function revokeVetRoleAction(input: {
  targetUserId: string;
  motivo: string;
  attachmentIds: string[];
}) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _revokeVetRole(user.id, input);
  if ("ok" in result) {
    // Usuarios is a dual-portal surface (portal-follows-viewer, 2026-07-02):
    // F3+F7 fusion (2026-07-22) made it the Directorio hub's "usuarios" tab
    // in BOTH portals — revalidate both hub routes.
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/directorio");
  }
  return result;
}

export async function revokeOrgVerificationAction(input: {
  organizationId: string;
  motivo: string;
  attachmentIds: string[];
}) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _revokeOrgVerification(user.id, input);
  if ("ok" in result) {
    // Organizaciones is a dual-portal surface (portal-follows-viewer,
    // 2026-07-02): F3+F7 fusion (2026-07-22) made it the Directorio hub's
    // "organizaciones" tab in BOTH portals — revalidate both hub routes.
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/directorio");
    // A revoked verification must drop the org from the public /refugios
    // directory (Data Cache, tag "org-directory") immediately, not after the
    // 300s window.
    revalidateTag("org-directory");
  }
  return result;
}

export async function revokeGovtLocalityAction(input: {
  govtAssignmentId: string;
  motivo: string;
  attachmentIds: string[];
}) {
  const { user } = await requireAdminOrGovtOrRedirect();
  const result = await _revokeGovtLocality(user.id, input);
  if ("ok" in result) {
    // Usuarios is a dual-portal surface (portal-follows-viewer, 2026-07-02):
    // F3+F7 fusion (2026-07-22) made it the Directorio hub's "usuarios" tab
    // in BOTH portals — revalidate both hub routes. Next.js silently ignores
    // paths for non-existent pages, so this is safe either way.
    revalidatePath("/admin/directorio");
    revalidatePath("/gob/directorio");
  }
  return result;
}
