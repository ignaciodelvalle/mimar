import { randomUUID } from "node:crypto";

import { heicRefusalMessage, isHeifContainer, metadataStripRefusalMessage } from "@/lib/media/heic";
import {
  MAX_IMAGE_BYTES,
  RASTER_IMAGE_TYPES,
  detectRasterMime,
  reencodeRaster,
} from "@/lib/media/validate";

const MAX_BYTES = MAX_IMAGE_BYTES;

// Buckets whose objects are publicly readable. Uploads to these buckets MUST be
// re-encoded through sharp so attacker-controlled bytes (polyglots, embedded
// scripts, malformed rasters) never reach a public URL verbatim.
const PUBLIC_REENCODE_BUCKETS = new Set(["pet-photos"]);

export type UploadResult = {
  uploadedPath: string | null;
  mimeType: string | null;
  size: number | null;
  error: string | null;
};

export type UploadOptions = {
  /**
   * REDUNDANT SINCE 2026-09-18, kept so the callers that opted in still read as
   * intent. Every raster this function accepts is now re-encoded through sharp,
   * which drops EXIF (GPS included), whether or not this is passed — see the
   * re-encoding decision below.
   *
   * Typed `true` and not `boolean` ON PURPOSE: `stripMetadata: false` used to
   * mean "store the original bytes", and it must not compile as a way back to
   * that. A caller that genuinely needs the original bytes (evidence whose EXIF
   * is itself evidence) does not belong on this helper — it needs its own path
   * and a PO decision.
   */
  stripMetadata?: true;
};

// Accept any Supabase client that exposes a `.storage` property — covers both
// the cookie-bound SSR client (@supabase/ssr) and the service-role admin
// client (@supabase/supabase-js). Anonymous server actions need the admin
// client to bypass the `to authenticated` RLS policy on the bucket.
type SupabaseStorageClient = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        file: File | Buffer,
        options?: { contentType?: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

export async function uploadAttachmentIfPresent(
  supabase: SupabaseStorageClient,
  file: File | null,
  bucket: string,
  _options?: UploadOptions,
): Promise<UploadResult> {
  if (!file || file.size === 0) {
    return { uploadedPath: null, mimeType: null, size: null, error: null };
  }
  if (file.size > MAX_BYTES) {
    return {
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: "La imagen no puede superar los 5 MB.",
    };
  }

  // Read the actual bytes and validate by MAGIC BYTES. `file.type` is
  // client-controlled — an attacker can label an SVG (or any payload) as
  // "image/jpeg", so we never trust it for a security decision. Anything that
  // is not a whitelisted raster (JPEG/PNG/WEBP) is rejected here, including
  // SVG (a stored-XSS vector on the public bucket).
  const inputBuffer = Buffer.from(await file.arrayBuffer());
  const detectedMime = detectRasterMime(inputBuffer);
  if (!detectedMime) {
    return {
      uploadedPath: null,
      mimeType: null,
      size: null,
      // HEIC is refused like any other non-whitelisted type, but it gets the
      // D4 sentence: it is the iPhone's default, and the person needs to know
      // how to send the same photo in a form we take.
      error: isHeifContainer(inputBuffer)
        ? heicRefusalMessage()
        : "El archivo debe ser una imagen JPG, PNG o WebP.",
    };
  }

  // The storage-key extension is derived from the VALIDATED MIME type, never
  // from the client filename. This closes the path-traversal hole where a name
  // like "x.jpg/../../evil" would inject "../" into the object key.
  const ext = RASTER_IMAGE_TYPES[detectedMime];
  const filename = `${randomUUID()}.${ext}`;

  // Re-encoding decision: EVERY accepted image is re-encoded, on every bucket.
  //  - Public buckets: normalized raster bytes only, so no attacker-controlled
  //    bytes are ever served from a public URL.
  //  - Private buckets (event-attachments): PO decision D4 (2026-09-18), "no
  //    guardar datos de ciudadanos que no nos dieron concientemente". Until
  //    then only callers passing `stripMetadata: true` were re-encoded, and the
  //    ~20 that did not — event, medical, adoption, Atender attachments — stored
  //    a phone photo's EXIF, GPS included, on the ordinary path. Nobody who
  //    attaches a vaccine card has consented to recording where they stood.
  // Everything reaching this point is a raster (JPEG/PNG/WebP) — anything else
  // was refused above — so "every image" and "every upload" are the same set.
  const isPublicBucket = PUBLIC_REENCODE_BUCKETS.has(bucket);

  let uploadBody: Buffer;
  try {
    uploadBody = await reencodeRaster(inputBuffer);
  } catch (err) {
    if (isPublicBucket) {
      // Public bucket: never fall back to the raw, un-normalized bytes.
      console.warn("[uploads] re-encode failed for public bucket, rejecting:", err);
      return {
        uploadedPath: null,
        mimeType: null,
        size: null,
        error: "No se pudo procesar la imagen. Probá con otra foto.",
      };
    }
    // FAILS CLOSED (D4). The opt-in path used to fall back to the original
    // file, which stored the GPS position of exactly the photos sharp could not
    // read. Nothing has been uploaded yet here, so refusing is the whole of the
    // rollback.
    console.warn("[uploads] EXIF strip failed, refusing rather than storing raw:", err);
    return {
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: metadataStripRefusalMessage(),
    };
  }

  // THE SIZE CHECK ABOVE BOUNDS THE INPUT; THE BUCKET BOUNDS WHAT WE UPLOAD, and
  // for a re-encoded body those are not the same number. `reencodeRaster` is
  // `sharp(buffer).rotate().toBuffer()` — no resize, no quality floor — so an
  // input UNDER `MAX_BYTES` can produce an output over it. A 5.1 MB indexed-
  // palette PNG is the concrete case: sharp re-encodes it non-palettised and
  // the result is larger than what came in.
  //
  // Until migration 0213 the bucket had no `file_size_limit` and the oversized
  // object simply landed. Now the Storage API refuses it, and the refusal
  // arrives as a raw provider message pasted into es-AR copy below — a sentence
  // about "no se pudo subir" for a photo the person was told was fine. The
  // failure is the migration's to own, so the guard is here rather than in a
  // release note.
  if (uploadBody.byteLength > MAX_BYTES) {
    return {
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: "La imagen es muy pesada después de procesarla. Probá con una foto más chica.",
    };
  }

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filename, uploadBody, { contentType: detectedMime });
  if (uploadError) {
    return {
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: `No se pudo subir la imagen: ${uploadError.message}`,
    };
  }
  // Report the size of what was actually stored — the re-encoded buffer, not
  // the original file.
  return { uploadedPath: filename, mimeType: detectedMime, size: uploadBody.length, error: null };
}
