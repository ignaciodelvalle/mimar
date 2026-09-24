"use client";

// Shared evidence-upload hook for the three admin revocation/deactivation forms
// (DeactivateAdminForm, DeactivateGovtForm, RevokeLocalityRowActions) — C23.
//
// WHAT CHANGED (C23)
// ------------------
// The forms used to upload each chosen file to Supabase Storage the moment it
// was SELECTED. Cancelling the form then left orphaned objects in the
// `revocations` bucket, and the path was namespaced by the ACTOR. This hook:
//   1. Holds the chosen File objects in state (NO upload on select).
//   2. Uploads on SUBMIT via `uploadAll(targetId)`, namespacing each object by
//      the TARGET being acted on (buildRevocationEvidencePath).
//   3. Returns attachment ids only after a successful submit-time upload.
// Cancelling never uploads, so orphans are impossible.

import { useCallback, useState } from "react";

import { uploadRevocationEvidence } from "@/app/actions/revocation-evidence";
import { buildRevocationEvidencePath } from "@/lib/domain/revocation-evidence-path";
import { createClient } from "@/lib/supabase/client";

export type SelectedFile = {
  // Stable client-side id for list keys / removal (the File has no id).
  key: string;
  file: File;
};

export type UploadAllResult = { attachmentIds: string[] } | { error: string };

export interface UseEvidenceUpload {
  /** Files chosen but NOT yet uploaded. */
  selectedFiles: SelectedFile[];
  /** True while an upload-on-submit is in flight. */
  uploading: boolean;
  /** Append chosen files to the pending list (does not upload). */
  addFiles: (files: File[]) => void;
  /** Remove a pending file before submit. */
  removeFile: (key: string) => void;
  /** Clear all pending files. */
  reset: () => void;
  /**
   * Upload every pending file to the `revocations` bucket under the TARGET's
   * namespace and register each via uploadRevocationEvidence. Returns the new
   * attachment ids, or a typed error (no partial registration is surfaced).
   * The acting user is derived server-side from the session — never passed in
   * (authz triage 2026-07-04).
   */
  uploadAll: (targetId: string) => Promise<UploadAllResult>;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `ev-${Date.now()}-${keySeq}`;
}

export function useEvidenceUpload(): UseEvidenceUpload {
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setSelectedFiles((prev) => [...prev, ...files.map((file) => ({ key: nextKey(), file }))]);
  }, []);

  const removeFile = useCallback((key: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  const reset = useCallback(() => setSelectedFiles([]), []);

  const uploadAll = useCallback(
    async (targetId: string): Promise<UploadAllResult> => {
      const pending = selectedFiles;
      if (pending.length === 0) return { error: "EVIDENCE_REQUIRED" };

      setUploading(true);
      const supabase = createClient();
      const attachmentIds: string[] = [];

      try {
        for (const { file } of pending) {
          const path = buildRevocationEvidencePath(targetId, file.name);

          const { error: storageError } = await supabase.storage
            .from("revocations")
            .upload(path, file, { contentType: file.type });

          if (storageError) {
            return { error: `Error al subir ${file.name}: ${storageError.message}` };
          }

          const result = await uploadRevocationEvidence({
            targetId,
            storagePath: path,
            mimeType: file.type,
            fileSize: file.size,
          });

          if ("error" in result) {
            return { error: `Error al registrar ${file.name}: ${result.error}` };
          }

          attachmentIds.push(result.attachmentId);
        }

        return { attachmentIds };
      } catch {
        return { error: "Error inesperado subiendo la evidencia." };
      } finally {
        setUploading(false);
      }
    },
    [selectedFiles],
  );

  return { selectedFiles, uploading, addFiles, removeFile, reset, uploadAll };
}
