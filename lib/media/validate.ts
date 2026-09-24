// Raster-image validation, on BYTES.
//
// WHY IT MOVED OUT OF lib/infra/uploads.ts
// ---------------------------------------------------------------------------
// `uploadAttachmentIfPresent` welds three security properties to a `File` that
// came out of a `FormData` that came out of a Server Action. RN-4's improvement
// #1 names that weld as the reason no non-browser client can upload at all, and
// docs/architecture/api-invariants.md §1.5 states the consequence as a rule:
//
//     "native uploading direct-to-storage with a signed URL loses all three at
//      once. No createSignedUploadUrl exists anywhere today — every signed URL
//      in the repo is a download. Keep it that way, or replicate all three
//      server-side first."
//
// This module is the "replicate all three server-side first" half. It holds the
// three properties and nothing else, over a `Buffer`, so the same code decides
// them whether the bytes arrived as a multipart `File` in a Server Action or
// were fetched back out of a staging bucket by a route handler.
//
// IT IS ONE COPY, NOT A SECOND ONE. `lib/infra/uploads.ts` imports from here
// rather than keeping its own; a duplicated magic-byte table is a table that
// disagrees with itself the first time somebody adds a format to one of them.
//
// THE THREE PROPERTIES, and which are universal:
//   · magic bytes — UNIVERSAL. `file.type` / a client-declared content type is
//     never trusted for a security decision.
//   · no SVG — UNIVERSAL, by whitelist construction. SVG is stored XSS when
//     served from a public bucket.
//   · re-encode — CALLER'S CHOICE, and the caller states it. Public-bucket
//     destinations must re-encode and must fail CLOSED; see uploads.ts.

/**
 * The whitelist of real raster types we accept.
 *
 * KEY is the canonical MIME (decided by magic bytes, never by the client);
 * VALUE is the storage-key extension derived from it. Deriving the extension
 * from the validated MIME is what keeps a client filename out of the object
 * key — see `rasterExtension`.
 */
export const RASTER_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type RasterMime = keyof typeof RASTER_IMAGE_TYPES;

/** Every MIME a caller may legally declare, as a runtime list for zod/enums. */
export const RASTER_MIME_LIST = Object.keys(RASTER_IMAGE_TYPES) as readonly RasterMime[];

// The size ceiling lives in ./limits so client code can import it without
// dragging sharp into the browser bundle.
export { MAX_IMAGE_BYTES } from "./limits";

/** Is this a MIME a caller may declare? Narrows on the way through. */
export function isRasterMime(value: string): value is RasterMime {
  return Object.hasOwn(RASTER_IMAGE_TYPES, value);
}

/** The storage-key extension for a VALIDATED mime. Never a client filename. */
export function rasterExtension(mime: RasterMime): string {
  return RASTER_IMAGE_TYPES[mime];
}

/**
 * Identify a raster image by its MAGIC BYTES (file signature).
 *
 * Returns the canonical MIME, or null when the bytes match no whitelisted
 * format. THIS is the authoritative content check: a declared content type is
 * attacker-controlled — an SVG, an HTML document or a ZIP can all be labelled
 * `image/jpeg` — and must never decide anything that matters.
 */
export function detectRasterMime(bytes: Uint8Array): RasterMime | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WEBP: "RIFF" (52 49 46 46) .... "WEBP" (57 45 42 50) at offset 8
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Re-encode a raster through sharp, dropping every metadata block.
 *
 * `.rotate()` bakes the EXIF orientation into the pixels and sharp then writes
 * the result WITHOUT metadata unless `.withMetadata()` is called — which is
 * deliberately not called. So the same line both normalises the bytes (no
 * polyglots, no embedded payloads) and strips GPS.
 *
 * Throws on any sharp error. The CALLER decides what a failure means: a public
 * destination must reject, a private one may fall back. That decision is not
 * this function's to make and it is not the same decision in both places.
 *
 * The import is dynamic to keep sharp out of any client bundle.
 *
 * THE PIXEL CEILING IS EXPLICIT (REENCODE_MAX_INPUT_PIXELS, below). Every
 * upload door bounds the BYTES that arrive (5 MB); none bounded what those bytes
 * DECODE to, and sharp's default `limitInputPixels` is 16383 × 16383 ≈ 268 MP.
 * A PNG is deflate-compressed, so a single-colour 16000 × 16000 image is a few
 * tens of kilobytes on the wire and ~1 GB decoded as RGBA — enough to kill the
 * function on every submission. Over the ceiling sharp throws before decoding,
 * and every caller already treats a throw as its fail-closed refusal.
 */
export async function reencodeRaster(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(buffer, { limitInputPixels: REENCODE_MAX_INPUT_PIXELS }).rotate().toBuffer();
}

/**
 * The largest image, in pixels, any upload may decode: 8192 × 8192 =
 * 67 108 864 (≈ 67 MP).
 *
 * Why that and not less: the largest phone photos people actually send are the
 * full-resolution modes — iPhone 48 MP (8064 × 6048 = 48 771 072) and the 50 MP
 * Android sensors (8160 × 6144 = 50 135 040). A 40 MP ceiling would refuse
 * both. Why not more: the worst case this admits decodes to 67 108 864 × 4
 * bytes (RGBA) ≈ 268 MB, a quarter of the ≈ 1 GB sharp's default admits, and
 * inside one function's memory. The 108-200 MP sensor modes are refused; their
 * JPEGs are well over the 5 MB byte ceiling every door already enforces.
 */
export const REENCODE_MAX_INPUT_PIXELS = 8192 * 8192;

// ---------------------------------------------------------------------------
// Decomiso evidence — raster photos plus the PDF acta (PO decision D10,
// 2026-09-18).
//
// History, so the shape is not mistaken for the old one: a raster+PDF
// whitelist used to live here and was removed because its destination,
// `event-attachments` (0213), only ever accepted JPG/PNG/WEBP up to 5 MiB —
// every PDF acta failed at upload after the officer filled the whole form. The
// PO decided the acta gets its own private bucket instead of widening the
// shared one: `decomiso-evidence` (0234) admits exactly DECOMISO_EVIDENCE_TYPES
// up to MAX_DECOMISO_EVIDENCE_BYTES, and only the service role writes to it.
//
// NOT RE-ENCODED, and not by oversight. PO decision D7 (2026-09-18): the
// metadata of seizure evidence (EXIF, GPS, capture time) is itself evidence,
// so the bytes are stored exactly as they arrived. That is safe only because
// the bucket is private and every read goes through the decomiso's own read
// rule (lib/infra/decomiso-evidence-access.ts). The type is still decided by
// the BYTES, never by the client, so no SVG/HTML/polyglot can be declared in.
// ---------------------------------------------------------------------------

/** Canonical MIME → storage-key extension for decomiso evidence. */
export const DECOMISO_EVIDENCE_TYPES = {
  ...RASTER_IMAGE_TYPES,
  "application/pdf": "pdf",
} as const;

export type DecomisoEvidenceMime = keyof typeof DECOMISO_EVIDENCE_TYPES;

export { DECOMISO_EVIDENCE_MIME_LIST, MAX_DECOMISO_EVIDENCE_BYTES } from "./limits";

/**
 * Identify decomiso evidence by its MAGIC BYTES: a whitelisted raster, or a PDF
 * (a file that starts with `%PDF-`, 25 50 44 46 2D). Null for anything else.
 */
export function detectDecomisoEvidenceMime(bytes: Uint8Array): DecomisoEvidenceMime | null {
  const raster = detectRasterMime(bytes);
  if (raster) return raster;
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return null;
}

/** The storage-key extension for a VALIDATED evidence mime. Never a client filename. */
export function decomisoEvidenceExtension(mime: DecomisoEvidenceMime): string {
  return DECOMISO_EVIDENCE_TYPES[mime];
}
