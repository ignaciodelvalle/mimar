// Upload size ceilings, as plain constants.
//
// Kept apart from ./validate.ts on purpose: that module imports sharp, and a
// client component that reaches it drags node:crypto/node:events into the
// browser bundle, which fails the build. Anything a form needs to show or
// pre-check lives here; ./validate.ts re-exports it for the server side.

/**
 * The size ceiling for a raster image, in bytes.
 *
 * Two enforcement points must agree on it: the Server Action path checks
 * `file.size` before reading, and the buckets declare the same number as their
 * `file_size_limit`, so the Storage API refuses an oversized PUT that no server
 * code ever sees. A limit the client volunteers is not a limit; a limit the
 * object store enforces is.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Decomiso evidence (PO decision D10, 2026-09-18): photos of the animal and the
 * acta, which is usually a PDF. It lives in its own private bucket,
 * `decomiso-evidence` (db/migrations/0234), whose `file_size_limit` and
 * `allowed_mime_types` are these two values — the same two-enforcement-points
 * rule as MAX_IMAGE_BYTES above.
 *
 * 10 MiB, not the 5 MiB photo ceiling: a scanned multi-page acta does not fit
 * in 5.
 */
export const MAX_DECOMISO_EVIDENCE_BYTES = 10 * 1024 * 1024;

/** The declared types the bucket admits. The server decides the REAL type by bytes. */
export const DECOMISO_EVIDENCE_MIME_LIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/**
 * The most evidence one decomiso may carry IN TOTAL. The whole form travels as
 * one Server Action request, and next.config.ts caps that body at 50 MB: ten
 * files at the per-file ceiling would be refused by the framework with a
 * generic error after the officer filled the whole form. 45 MiB leaves room
 * for the multipart overhead and the rest of the form.
 */
export const MAX_DECOMISO_EVIDENCE_TOTAL_BYTES = 45 * 1024 * 1024;
