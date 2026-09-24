"use server";

// admin-institutional.ts — thin shim (strangler migration 5/61).
//
// Business logic moved to:
//   src/modules/organizations/application/admin-institutional/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The ForAuthority writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied actorUserId would let any client act as any admin. Callers
// that need a writer import it from its application module directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { assignGovtLocalityForAuthority as _assignGovtLocality } from "@/src/modules/organizations/application/admin-institutional/assign-govt-locality";
import { createInstitutionalAccountForAuthority as _createInstitutional } from "@/src/modules/organizations/application/admin-institutional/create-institutional-account";
import { deactivateAdminForAuthority as _deactivateAdmin } from "@/src/modules/organizations/application/admin-institutional/deactivate-admin";
import { deactivateGovtForAuthority as _deactivateGovt } from "@/src/modules/organizations/application/admin-institutional/deactivate-govt";
import { resetInstitutionalCredentialsForAuthority as _resetCredentials } from "@/src/modules/organizations/application/admin-institutional/reset-institutional-credentials";
import { resetMfaFactorsForAuthority as _resetMfaFactors } from "@/src/modules/organizations/application/admin-institutional/reset-mfa-factors";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { AssignGovtLocalityResult } from "@/src/modules/organizations/application/admin-institutional/types";
export type { CreateInstitutionalResult } from "@/src/modules/organizations/application/admin-institutional/types";
export type { DeactivateResult } from "@/src/modules/organizations/application/admin-institutional/types";
export type { ResetCredentialsResult } from "@/src/modules/organizations/application/admin-institutional/types";
export type { ResetMfaFactorsResult } from "@/src/modules/organizations/application/admin-institutional/reset-mfa-factors";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function createInstitutionalAccountAction(input: {
  role: "govt" | "admin" | "national";
  email: string;
  displayName: string;
  initialLocalities: { province: string; locality: string }[];
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await _createInstitutional(user.id, input);
  if ("ok" in result) {
    revalidatePath("/admin/govts");
    revalidatePath("/admin/admins");
  }
  return result;
}

export async function deactivateAdminAction(input: {
  targetAdminUserId: string;
  motivo: string;
  attachmentIds: string[];
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await _deactivateAdmin(user.id, input);
  if ("ok" in result && !result.noOp) {
    revalidatePath("/admin/admins");
    revalidatePath(`/admin/admins/${input.targetAdminUserId}`);
  }
  return result;
}

export async function deactivateGovtAction(input: {
  targetGovtUserId: string;
  motivo: string;
  attachmentIds: string[];
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await _deactivateGovt(user.id, input);
  if ("ok" in result && !result.noOp) {
    revalidatePath("/admin/govts");
    revalidatePath(`/admin/govts/${input.targetGovtUserId}`);
  }
  return result;
}

export async function resetInstitutionalCredentialsAction(input: {
  targetUserId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await _resetCredentials(user.id, input);
  // A reset whose session revocation failed DEACTIVATES the target; the
  // account pages must show that at once, not after a manual reload.
  if ("error" in result) {
    revalidatePath("/admin/govts");
    revalidatePath(`/admin/govts/${input.targetUserId}`);
  }
  return result;
}

// T2-S6: admin-assisted second-factor recovery (no Supabase recovery codes).
// It runs the credential reset too, and a failed session revocation there
// DEACTIVATES the target — so the pages are revalidated on errors as well.
export async function resetMfaFactorsAction(input: { targetUserId: string; reason: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await _resetMfaFactors(user.id, input);
  revalidatePath("/admin/govts");
  revalidatePath(`/admin/govts/${input.targetUserId}`);
  revalidatePath(`/admin/admins/${input.targetUserId}`);
  return result;
}

export async function assignGovtLocalityAction(input: {
  targetUserId: string;
  province: string;
  locality: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await _assignGovtLocality(user.id, input);
  if ("ok" in result && !result.noOp) {
    revalidatePath(`/admin/govts/${input.targetUserId}`);
  }
  return result;
}
