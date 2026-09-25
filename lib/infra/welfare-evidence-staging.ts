// Denuncia evidence from a phone — the staging half (M12).
//
// THE SAME TWO-STEP AS THE PET PHOTO, OVER THE SAME PRIVATE BUCKET. A ticket
// mints a signed upload URL into `uploads-staging` (migration 0206: private,
// 5 MB, jpeg/png/webp only, no caller-facing policy); the phone PUTs the bytes;
// `file` names the staged keys. Nothing is believed about a staged object until
// `loadStagedWelfareEvidence` has downloaded it and handed it to the WEB's own
// gate — `prepareWelfareEvidence` in `welfare-uploads.ts`: count, type, size,
// HEIC refusal and the EXIF/GPS strip that fails closed. There is no second
// validation path here, which is the rule `app/api/v1/welfare-reports/route.ts`
// has stated since the door was written: uploads go through that helper, not
// beside it.
//
// THE KEY NAMES NOBODY. `welfare/{uuid}.{ext}` — unlike the pet photo's
// `{petId}/…`, no part is derived from the caller, because an anonymous
// denuncia's evidence must not sit in storage under the reporter's id, not even
// for the minutes between upload and filing. The final object lives at
// `{reportId}/{uuid}{ext}` in `welfare-evidence` (the web's path) and the
// staged copy is deleted once the filing has used it.
//
// RESIDUAL, NAMED: a ticket that is never filed leaves its object in staging.
// Same residual as the pet photo's (migration 0206 names it), bounded by the
// bucket's 5 MB ceiling and the ticket rate limit.

import { randomUUID } from "node:crypto";

import {
  STAGING_BUCKET,
  SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS,
} from "@/lib/infra/pet-photo-upload";
import { MAX_IMAGE_BYTES, type RasterMime, rasterExtension } from "@/lib/media/validate";
import { createAdminClient } from "@/lib/supabase/admin";
import { WELFARE_EVIDENCE_STAGED_PATH_RE } from "@dim/contract/input";

/**
 * The ONE service-role handle this module takes (it bypasses RLS: the bucket
 * admits no caller at all). One call site, so the architecture census counts
 * this module once, and every use below goes through it.
 */
function stagingBucket() {
  return createAdminClient().storage.from(STAGING_BUCKET);
}

export type WelfareEvidenceTicket = {
  uploadUrl: string;
  token: string;
  stagedPath: string;
  bucket: string;
  validForSeconds: number;
};

/** Mint one upload URL for one evidence photo. The caller has authenticated. */
export async function mintWelfareEvidenceTicket(
  contentType: RasterMime,
): Promise<WelfareEvidenceTicket | null> {
  const stagedPath = `welfare/${randomUUID()}.${rasterExtension(contentType)}`;
  const { data, error } = await stagingBucket().createSignedUploadUrl(stagedPath);
  if (error || !data?.signedUrl || !data.token) {
    // No path, no caller in the log line: the key is random and says nothing.
    console.error("[welfare-evidence] could not mint an upload ticket", {
      message: error?.message ?? "no signed url returned",
    });
    return null;
  }
  return {
    uploadUrl: data.signedUrl,
    token: data.token,
    stagedPath,
    bucket: STAGING_BUCKET,
    validForSeconds: SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS,
  };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type LoadedStagedEvidence = { ok: true; files: File[] } | { ok: false };

/**
 * Download every staged key as a `File` the web's gate can judge.
 *
 * Re-checks the key shape HERE even though the contract's schema did, because
 * this is the function that hands a path to the object store. A missing object,
 * an empty one or one over the ceiling refuses the whole set — the filing either
 * carries every photo the person chose or none, never a silent subset.
 *
 * The file NAME is `evidencia-N.ext`: `originalFilename` is stored on the
 * attachment row, and a phone's camera filename can carry a date, a device name
 * or worse. Nothing the person did not type reaches the record.
 */
export async function loadStagedWelfareEvidence(
  stagedPaths: readonly string[],
): Promise<LoadedStagedEvidence> {
  if (stagedPaths.length === 0) return { ok: true, files: [] };
  const bucket = stagingBucket();
  const files: File[] = [];
  for (const [index, path] of stagedPaths.entries()) {
    const match = WELFARE_EVIDENCE_STAGED_PATH_RE.exec(path);
    const ext = match?.[1];
    const mime = ext === undefined ? undefined : MIME_BY_EXTENSION[ext];
    if (mime === undefined) return { ok: false };
    try {
      const { data, error } = await bucket.download(path);
      if (error || !data) return { ok: false };
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false };
      files.push(new File([bytes], `evidencia-${index + 1}.${ext}`, { type: mime }));
    } catch (err) {
      console.error("[welfare-evidence] could not read a staged object", {
        message: err instanceof Error ? err.message : String(err),
      });
      return { ok: false };
    }
  }
  return { ok: true, files };
}

/** Best-effort: the staged copies, once the filing has used (or refused) them. */
export async function removeStagedWelfareEvidence(stagedPaths: readonly string[]): Promise<void> {
  if (stagedPaths.length === 0) return;
  try {
    await stagingBucket().remove([...stagedPaths]);
  } catch {
    // A leftover staged object is the named residual above, not an error.
  }
}
