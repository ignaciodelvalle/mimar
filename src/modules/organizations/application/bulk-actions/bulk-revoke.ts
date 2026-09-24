// bulk-revoke use-case (strangler 35/61).
// Whole-body verbatim move from app/actions/bulk-actions.ts — the motivo /
// attachment pre-validation runs BEFORE the auth guard (and the validation
// fast-fail paths skip revalidatePath), exactly as in the original. Writers are
// imported directly from their modules (not the action shims).

import { randomUUID } from "node:crypto";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { revokeGovtLocalityForAuthority } from "@/src/modules/organizations/application/revocations/revoke-govt-locality";
import { revokeOrgVerificationForAuthority } from "@/src/modules/organizations/application/revocations/revoke-org-verification";
import { revokeVetRoleForAuthority } from "@/src/modules/organizations/application/revocations/revoke-vet-role";

import type { BulkResult, BulkRevokeInput } from "./types";

export async function bulkRevoke(input: BulkRevokeInput): Promise<BulkResult> {
  const bulkActionId = randomUUID();
  const motivo = input.motivo.trim();
  // The single-writer validates len ≥ 30 and at least 1 attachment; we
  // pre-check here so the entire batch fails fast with one clean error
  // instead of N copies.
  if (motivo.length < 30) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.targetIds.map((id) => ({
        id,
        reason: "El motivo de la revocación debe tener al menos 30 caracteres.",
      })),
    };
  }
  if (input.attachmentIds.length === 0) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.targetIds.map((id) => ({
        id,
        reason: "La revocación requiere al menos un adjunto de evidencia.",
      })),
    };
  }

  const session = await requireAdminOrGovtOrRedirect();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of input.targetIds) {
    try {
      let result: { ok: true; noOp?: boolean } | { error: string };
      if (input.targetKind === "vet") {
        result = await revokeVetRoleForAuthority(session.user.id, {
          targetUserId: id,
          motivo,
          attachmentIds: input.attachmentIds,
          bulkActionId,
        });
      } else if (input.targetKind === "org") {
        result = await revokeOrgVerificationForAuthority(session.user.id, {
          organizationId: id,
          motivo,
          attachmentIds: input.attachmentIds,
          bulkActionId,
        });
      } else {
        result = await revokeGovtLocalityForAuthority(session.user.id, {
          govtAssignmentId: id,
          motivo,
          attachmentIds: input.attachmentIds,
          bulkActionId,
        });
      }
      if ("error" in result) {
        failed.push({ id, reason: result.error });
      } else {
        succeeded.push(id);
      }
    } catch (err) {
      failed.push({ id, reason: err instanceof Error ? err.message : "unknown_error" });
    }
  }

  // F3+F7 fusion (2026-07-22): Usuarios/Organizaciones are now the
  // Directorio hub's tabs (both gob and admin have their own hub route) —
  // revalidate the hub routes, not the old redirect-only shims.
  revalidatePath("/admin/directorio");
  revalidatePath("/gob/directorio");
  revalidatePath("/admin/govts");
  // RA-2 F12 — the pages that actually HOST the bulk-revoke control. The three
  // paths above are the read-only hub views; the <BulkRevokeList> checkbox
  // queue lives on /gob/usuarios and /gob/organizaciones. Because neither was
  // revalidated, the RSC patch that Next applies after this action returned the
  // SAME rows the operator had just revoked — still rendered as active, still
  // offering a live "Revocar" button — and the modal's "Recargar lista" button
  // (which only closes the modal) could not correct it either.
  revalidatePath("/gob/usuarios");
  revalidatePath("/gob/organizaciones");
  // targetKind === "org" revocations drop orgs from the public /refugios
  // directory (Data Cache, tag "org-directory") — invalidate rather than
  // serving the stale roster for the 300s window.
  revalidateTag("org-directory");
  return { bulkActionId, succeeded, failed };
}
