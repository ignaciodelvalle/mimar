// Pre-upload use-case for revocation evidence attachments.
//
// The client uploads the file to Supabase Storage directly, then calls
// this function with the resulting storage path + metadata. The function creates
// an `attachments` row with all foreign-keys NULL (no audit_log_id yet).
// The revocation writer later "claims" the attachment by setting audit_log_id
// inside the transaction.
//
// Design §2f, spec REQ-6.

import { eq } from "drizzle-orm";

import { attachments, db, profiles } from "@/db";

export type UploadEvidenceInput = {
  /** The path-namespace prefix the storagePath must live under (the first path
   * segment). By convention this is the target of the revocation, though the
   * three inline callers namespace by the acting operator's id — either way the
   * storagePath must match it. This is a shape check, not an authz control (see
   * storagePathIsUnderTarget). */
  targetId: string;
  storagePath: string;
  mimeType: string;
  fileSize?: number | null;
};

export type UploadEvidenceResult = { attachmentId: string } | { error: string };

/**
 * SHAPE guard, not an authorization control. It asserts that `storagePath` is a
 * well-formed `{targetId}/{basename}` — a single separator, a non-traversing
 * segment on each side — so the use-case never registers an `attachments` row
 * pointing at a malformed or traversing key. It does NOT prove provenance:
 * `targetId` and `storagePath` arrive in the same client payload, so this
 * cannot stop a caller declaring a different target. The real control is the
 * RLS INSERT policy (migration 0188, admin/govt-only) plus the action
 * boundary's requireAdminOrGovtOrRedirect; this is defense-in-depth on the row
 * shape only. The bucket has no reader anywhere, so a mis-declared target is
 * inert regardless.
 */
function storagePathIsUnderTarget(storagePath: string, targetId: string): boolean {
  // Reject a traversing or separator-bearing target segment outright.
  if (!targetId || targetId.includes("/") || targetId === "." || targetId.includes("..")) {
    return false;
  }
  const prefix = `${targetId}/`;
  if (!storagePath.startsWith(prefix)) return false;
  const basename = storagePath.slice(prefix.length);
  // Exactly one path segment after the target, no traversal, no nesting.
  return basename.length > 0 && !basename.includes("/") && !basename.includes("..");
}

// Validates that the caller is an admin or govt user, then inserts an
// attachments row with all FKs NULL. Returns the new attachment id.
//
// Note: this use-case deliberately does NOT call requireAdminOrGovtOrRedirect
// (which redirects) — it returns a typed error so the caller can handle it
// without a page redirect (the upload is triggered from a form, not a page
// navigation).
//
// `actorUserId` MUST be session-derived by the caller. The only server-action
// entry point (app/actions/revocation-evidence.ts) resolves it from
// supabase.auth.getUser() — it is never accepted from the client
// (authz triage 2026-07-04). The role check below (admin | govt) then gates
// the write against that session identity.
export async function uploadRevocationEvidence(
  actorUserId: string,
  input: UploadEvidenceInput,
): Promise<UploadEvidenceResult> {
  // Capability check — only admin/govt may upload revocation evidence.
  const [profile] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);
  if (!profile || (profile.role !== "admin" && profile.role !== "govt")) {
    return { error: "Solo admin o govt pueden subir evidencia de revocación." };
  }

  // Bind the object to the target namespace before trusting it (RN-4/B3).
  if (!storagePathIsUnderTarget(input.storagePath, input.targetId)) {
    return { error: "La ruta de la evidencia no corresponde al objetivo de la acción." };
  }

  const [row] = await db
    .insert(attachments)
    .values({
      uploadedByUserId: actorUserId,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      fileSize: input.fileSize ?? null,
      // All domain FKs stay NULL at upload time — claimed by the writer.
    })
    .returning({ id: attachments.id });

  return { attachmentId: row.id };
}
