"use server";

// revocation-evidence.ts — thin shim (strangler migration 55/61).
//
// Business logic moved to:
//   src/modules/organizations/application/revocations/upload-evidence.ts
//
// The actor is derived from the Supabase session HERE — never accepted from
// the client (authz triage 2026-07-04: the old signature took a
// caller-supplied actorUserId, letting any authenticated caller act as any
// admin/govt whose UUID was known).
//
// The action boundary now gates with requireAdminOrGovtOrRedirect — the SAME
// full-invariant institutional guard admin-revocations.ts uses (role ∈
// {admin,govt} + accountType==='institutional' + deactivatedAt IS NULL +
// deletedAt IS NULL). The delegated use-case still re-checks role as
// data-layer defense-in-depth, but the boundary is now the primary gate:
// previously entry did only getUser(), so a DEACTIVATED operator or an ERASED
// (soft-deleted, session still valid — Ley 25.326 art. 16) admin/govt whose
// role column still read 'admin'/'govt' passed the use-case's role-only check.

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import type {
  UploadEvidenceInput,
  UploadEvidenceResult,
} from "@/src/modules/organizations/application/revocations/upload-evidence";
import { uploadRevocationEvidence as _uploadEvidence } from "@/src/modules/organizations/application/revocations/upload-evidence";

export type {
  UploadEvidenceInput,
  UploadEvidenceResult,
} from "@/src/modules/organizations/application/revocations/upload-evidence";

export async function uploadRevocationEvidence(
  input: UploadEvidenceInput,
): Promise<UploadEvidenceResult> {
  const { user } = await requireAdminOrGovtOrRedirect();
  return _uploadEvidence(user.id, input);
}
