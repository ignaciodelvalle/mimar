// Multi-file upload helper for welfare evidence.
//
// Kept separate from lib/uploads.ts — different bucket, different lifecycle
// (anonymous-capable), different MIME set, and multi-file semantics.
//
// STORAGE IDENTITY (RA-8 R2, migration 0164): the `welfare-evidence` bucket has
// no anon/authenticated policy. It used to grant `anon` unrestricted INSERT and
// a SELECT that named no caller at all, which made the whole national corpus of
// cruelty-complaint evidence anonymously listable and downloadable. Both legs
// now run as service role from here.
//
// The anonymous denuncia still works: "anonymous" describes the REPORTER, not
// the storage caller. The upload has always happened inside a server action
// (createWelfareReportAction and friends) after that action validated the
// submission — the browser never touched the bucket.
//
// Side effect worth naming: rollback actually works now. The bucket had no
// DELETE policy, so every `.remove()` in the failure paths was silently denied
// and leaked orphaned objects.

import {
  HEIF_SNIFF_BYTES,
  heicRefusalMessage,
  isDeclaredHeic,
  isHeifContainer,
  metadataStripRefusalMessage,
} from "@/lib/media/heic";
import { detectRasterMime, reencodeRaster } from "@/lib/media/validate";

const BUCKET = "welfare-evidence";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
// HEIC/HEIF are NOT here, and that is a decision, not an omission: PO D4
// (2026-09-18) refuses them rather than transcoding. See lib/media/heic.ts.
// Video stays accepted with its metadata until the D4b neutraliser lands
// (dim-interno:docs/handoff/rumbo-al-piloto.md, T2-P3).
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

// Raster image types re-encoded through sharp to strip EXIF/GPS metadata. The
// strip FAILS CLOSED: a file of one of these types is stored stripped or not at
// all. GIF is not re-encoded (sharp would flatten an animation); it has no
// camera EXIF block, which is where a phone writes its GPS position.
const STRIP_EXIF_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * ¿Podemos garantizar que este archivo se guardó SIN metadatos (GPS incluido)?
 *
 * Sólo para los tipos que `sharp` re-encodea acá, y para esos la garantía es
 * dura: si el re-encode falla, la subida se rechaza y se deshace (D4, fail
 * closed), nunca se guarda el original. HEIC/HEIF ya no se aceptan (D4). Para
 * GIF y video los bytes se suben tal cual: un GIF no lleva EXIF de cámara, y el
 * video del iPhone SÍ lleva GPS hasta que llegue el neutralizador de D4b.
 *
 * POR QUÉ SIGUE EXPORTADA AUNQUE HOY NO GATEA NINGUNA SUPERFICIE VIVA. Guardaba
 * el comprobante público (`/denuncias/codigo/[code]`): esa lectura SIN sesión
 * condicionaba a esto si firmaba una URL hacia la evidencia. La página fue
 * endurecida después y hoy NO lee `welfareReportAttachments` ni firma ninguna
 * URL en absoluto — el denunciante conserva sus propios archivos y el organismo
 * los recibe por su camino autenticado (Ley 14.346) — así que esta función no
 * gatea nada en producción. Sigue exportada y probada
 * (`__tests__/welfare-coordinates-precision.test.ts`, que además pin-ea que el
 * comprobante NO la llama) por si una superficie pública vuelve a servir
 * evidencia y necesita el mismo criterio.
 *
 * Si se reactiva, falla cerrado por construcción: si mañana se agrega un
 * formato a ALLOWED_MIME sin sumarlo acá, la respuesta correcta es NO
 * exponerlo, no filtrarlo.
 */
export function isMetadataStripped(mimeType: string | null | undefined): boolean {
  return mimeType !== null && mimeType !== undefined && STRIP_EXIF_MIME.has(mimeType);
}

export type WelfareUploadResult = {
  error: string | null;
  uploaded: Array<{
    storagePath: string;
    mimeType: string;
    fileSize: number;
    originalFilename: string | null;
  }>;
  // Paths to clean up if the calling code decides to roll back (e.g., the
  // attachments row insert fails).
  uploadedPaths: string[];
};

/** Service-role storage handle for the private welfare-evidence bucket. */
async function evidenceBucket() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient().storage.from(BUCKET);
}

/**
 * Delete welfare-evidence objects. Used by the transaction-rollback paths so a
 * failed denuncia does not leave orphaned evidence in the bucket.
 * Best-effort: never throws.
 */
export async function removeWelfareEvidence(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;
  try {
    await (await evidenceBucket()).remove(storagePaths);
  } catch (err) {
    console.warn("[welfare-uploads] evidence cleanup failed (non-fatal):", err);
  }
}

/** Only the count check — needs the whole list, not one file at a time. */
function checkFileCount(real: File[]): string | null {
  if (real.length > MAX_FILES) return `No podés adjuntar más de ${MAX_FILES} archivos.`;
  return null;
}

/**
 * The per-file checks that need no storage and no sharp: HEIC/HEIF, declared
 * type, size. Shared by `checkWelfareEvidence` and `prepareWelfareEvidence` so
 * the two never drift.
 *
 * HEIC is recognised by its declared type or extension AND by the bytes: a
 * picker can hand over an iPhone photo labelled `image/jpeg` or with no type at
 * all, and the first bytes are the only thing the client does not choose.
 */
async function cheapFileCheck(f: File): Promise<string | null> {
  const head = new Uint8Array(await f.slice(0, HEIF_SNIFF_BYTES).arrayBuffer());
  if (isDeclaredHeic(f) || isHeifContainer(head)) return heicRefusalMessage(f.name || null);
  if (!ALLOWED_MIME.has(f.type)) {
    return `Tipo de archivo no soportado: ${f.type || "desconocido"}. Solo imágenes y videos.`;
  }
  if (f.size > MAX_FILE_BYTES) return `Archivo "${f.name}" supera el límite de 25 MB.`;
  return null;
}

type StripResult =
  | { ok: true; uploadBody: File | Buffer; storedSize: number; mimeType: string }
  | { ok: false; error: string };

/**
 * Decide whether `f` gets its metadata stripped, and do it if so.
 *
 * FIX B (2026-09-18 security review): the decision used to be
 * `STRIP_EXIF_MIME.has(f.type)` — the client-DECLARED type. A camera JPEG
 * declared `image/gif` or `video/mp4` passes `ALLOWED_MIME` and used to be
 * stored raw, GPS included. Now the BYTES decide first: `detectRasterMime`
 * sniffs the real magic number, and any file that sniffs as JPEG/PNG/WebP is
 * stripped and stored under the SNIFFED mime — whatever was declared. Genuine
 * GIFs and videos (which don't sniff as a raster type here) are left alone,
 * same as before.
 *
 * The declared-type check stays as a fallback OR so a file that DECLARES a
 * strippable type but fails to sniff as one (corrupt bytes, truncated upload)
 * still goes through sharp and hits the fail-closed refusal below, instead of
 * silently skipping the strip because the magic number didn't parse.
 *
 * FAILS CLOSED (D4). This used to fall back to the ORIGINAL bytes when sharp
 * threw, on the reasoning "we'd rather store metadata than fail the whole
 * denuncia" — which stored exactly the position the strip exists to drop, for
 * exactly the files sharp could not read. Now the submission is refused and
 * the caller is expected to remove anything already stored, the same shape as
 * `claimStagedEventAttachment` (lib/infra/staged-event-attachment.ts).
 */
async function stripIfRaster(f: File): Promise<StripResult> {
  const head = new Uint8Array(await f.slice(0, HEIF_SNIFF_BYTES).arrayBuffer());
  const sniffed = detectRasterMime(head);
  const shouldStrip = STRIP_EXIF_MIME.has(f.type) || sniffed !== null;
  const mimeType = sniffed ?? f.type;

  if (!shouldStrip) {
    return { ok: true, uploadBody: f, storedSize: f.size, mimeType };
  }
  try {
    const processed = await reencodeRaster(Buffer.from(await f.arrayBuffer()));
    return { ok: true, uploadBody: processed, storedSize: processed.length, mimeType };
  } catch (err) {
    console.warn("[welfare-uploads] EXIF strip failed, refusing rather than storing raw:", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: metadataStripRefusalMessage(f.name || null) };
  }
}

/**
 * The checks that need no storage: count, HEIC/HEIF, type, size. Returns the
 * es-AR refusal, or null when the set may be uploaded.
 *
 * Does NOT run the EXIF strip — see `prepareWelfareEvidence` for the full
 * pre-insert gate the denuncia actions use. This narrower function is kept
 * for callers that only need the cheap shape checks.
 *
 * HEIC is recognised by its declared type or extension AND by the bytes: a
 * picker can hand over an iPhone photo labelled `image/jpeg` or with no type at
 * all, and the first bytes are the only thing the client does not choose.
 */
export async function checkWelfareEvidence(files: File[]): Promise<string | null> {
  const real = files.filter((f) => f && f.size > 0);
  const countError = checkFileCount(real);
  if (countError) return countError;
  for (const f of real) {
    const err = await cheapFileCheck(f);
    if (err) return err;
  }
  return null;
}

export type PreparedWelfareFile = {
  file: File;
  uploadBody: File | Buffer;
  storedSize: number;
  mimeType: string;
};

export type PrepareWelfareEvidenceResult = {
  error: string | null;
  prepared: PreparedWelfareFile[];
};

/**
 * The FULL pre-insert gate (Fix A, 2026-09-18 security review): count, HEIC,
 * type, size, AND the EXIF strip.
 *
 * Before this existed, only the storage-free checks ran before a caller that
 * inserts a row before uploading (the denuncia create actions, by design)
 * could refuse up front — the strip's fail-closed refusal only happened
 * INSIDE the old upload step, which necessarily ran AFTER that insert. A
 * corrupt JPEG (or any file sharp could not decode) then left a report row
 * with no evidence behind, worse on every retry. This runs the strip here
 * instead and hands the already-processed bodies forward, so the caller only
 * inserts once every file is already known-clean — see
 * `uploadPreparedWelfareEvidence`, which does no re-checking and no
 * re-stripping.
 */
export async function prepareWelfareEvidence(files: File[]): Promise<PrepareWelfareEvidenceResult> {
  const real = files.filter((f) => f && f.size > 0);
  const countError = checkFileCount(real);
  if (countError) return { error: countError, prepared: [] };

  const prepared: PreparedWelfareFile[] = [];
  for (const f of real) {
    const cheapError = await cheapFileCheck(f);
    if (cheapError) return { error: cheapError, prepared: [] };

    const stripped = await stripIfRaster(f);
    if (!stripped.ok) return { error: stripped.error, prepared: [] };
    prepared.push({
      file: f,
      uploadBody: stripped.uploadBody,
      storedSize: stripped.storedSize,
      mimeType: stripped.mimeType,
    });
  }
  return { error: null, prepared };
}

/**
 * Upload already-`prepareWelfareEvidence`d files. Pure storage I/O: no
 * checks, no stripping — everything that can refuse the submission already
 * ran before the caller inserted its row. Rolls itself back on a partial
 * storage failure, same as `uploadWelfareEvidence`.
 */
export async function uploadPreparedWelfareEvidence(
  reportId: string,
  prepared: PreparedWelfareFile[],
): Promise<WelfareUploadResult> {
  if (prepared.length === 0) return { error: null, uploaded: [], uploadedPaths: [] };

  const uploaded: WelfareUploadResult["uploaded"] = [];
  const uploadedPaths: string[] = [];

  let bucket: Awaited<ReturnType<typeof evidenceBucket>>;
  try {
    bucket = await evidenceBucket();
  } catch (err) {
    // Fail closed and loud: a missing service-role key means evidence cannot
    // be stored at all, and silently accepting a denuncia with no evidence is
    // worse than telling the reporter to retry.
    console.error("[welfare-uploads] service-role storage client unavailable:", err);
    return {
      error: "No se pudo guardar la evidencia. Intentá de nuevo en unos minutos.",
      uploaded: [],
      uploadedPaths: [],
    };
  }

  for (const p of prepared) {
    const ext = inferExtension(p.file.name, p.mimeType);
    const attachmentId = crypto.randomUUID();
    const path = `${reportId}/${attachmentId}${ext}`;

    const { error } = await bucket.upload(path, p.uploadBody, {
      contentType: p.mimeType,
      upsert: false,
    });
    if (error) {
      // Roll back what we already uploaded.
      await removeWelfareEvidence(uploadedPaths);
      return {
        error: `No se pudo subir "${p.file.name}": ${error.message}`,
        uploaded: [],
        uploadedPaths: [],
      };
    }
    uploaded.push({
      storagePath: path,
      mimeType: p.mimeType,
      fileSize: p.storedSize,
      originalFilename: p.file.name || null,
    });
    uploadedPaths.push(path);
  }

  return { error: null, uploaded, uploadedPaths };
}

/**
 * Validate, strip, and upload in one call — for a caller that uploads BEFORE
 * any row exists (so an early refusal leaves nothing behind either way).
 * `submit-claim-dispute.ts` is the one remaining caller shaped like that; the
 * denuncia create actions use `prepareWelfareEvidence` +
 * `uploadPreparedWelfareEvidence` directly instead, because THEY insert a row
 * first and need the gate to run before that insert, not around this call.
 */
export async function uploadWelfareEvidence(
  reportId: string,
  files: File[],
): Promise<WelfareUploadResult> {
  const real = files.filter((f) => f && f.size > 0);
  if (real.length === 0) return { error: null, uploaded: [], uploadedPaths: [] };

  const prep = await prepareWelfareEvidence(real);
  if (prep.error) return { error: prep.error, uploaded: [], uploadedPaths: [] };

  return uploadPreparedWelfareEvidence(reportId, prep.prepared);
}

function inferExtension(filename: string, mime: string): string {
  const fromName = filename.includes(".") ? `.${filename.split(".").pop()?.toLowerCase()}` : "";
  if (fromName) return fromName;
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/webm") return ".webm";
  if (mime === "video/quicktime") return ".mov";
  return "";
}
