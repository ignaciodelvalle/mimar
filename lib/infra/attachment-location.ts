// Where an `attachments.storage_path` actually lives, and whether it is
// decomiso evidence. Pure — no DB, no Storage client — so every reader and the
// fences can share one answer.
//
// `attachments` has no bucket column. Event attachments have always lived in
// `event-attachments`, and every signer assumed so. Decomiso evidence breaks
// that assumption on purpose (PO decision D10, 2026-09-18): new evidence goes
// to the private `decomiso-evidence` bucket (db/migrations/0234), and its row
// records the path WITH the bucket name as its first segment. That prefix is
// the whole routing rule, chosen over a new column because it needs no schema
// change and a legacy row can never be mistaken for a new one:
//
//   decomiso-evidence/<dir>/<file>  → bucket decomiso-evidence, key <dir>/<file>
//   decomiso/<dir>/<file>           → bucket event-attachments (legacy evidence,
//                                     uploaded before 0234), key unchanged
//   anything else                   → bucket event-attachments, key unchanged

export const EVENT_ATTACHMENTS_BUCKET = "event-attachments";

/** Private, service-role-only bucket for decomiso evidence (0234). */
export const DECOMISO_EVIDENCE_BUCKET = "decomiso-evidence";

const DECOMISO_EVIDENCE_ROW_PREFIX = `${DECOMISO_EVIDENCE_BUCKET}/`;

/** Key prefix of the evidence uploaded to event-attachments before 0234. */
const LEGACY_DECOMISO_PREFIX = "decomiso/";

export type AttachmentLocation = {
  bucket: typeof EVENT_ATTACHMENTS_BUCKET | typeof DECOMISO_EVIDENCE_BUCKET;
  objectPath: string;
};

/** The bucket and object key an event attachment's `storage_path` names. */
export function eventAttachmentLocation(storagePath: string): AttachmentLocation {
  if (storagePath.startsWith(DECOMISO_EVIDENCE_ROW_PREFIX)) {
    return {
      bucket: DECOMISO_EVIDENCE_BUCKET,
      objectPath: storagePath.slice(DECOMISO_EVIDENCE_ROW_PREFIX.length),
    };
  }
  return { bucket: EVENT_ATTACHMENTS_BUCKET, objectPath: storagePath };
}

/** The `storage_path` to record for an object stored in decomiso-evidence. */
export function decomisoEvidenceRowPath(objectPath: string): string {
  return `${DECOMISO_EVIDENCE_ROW_PREFIX}${objectPath}`;
}

/**
 * Is this attachment decomiso evidence — new (decomiso-evidence bucket) or
 * legacy (event-attachments, `decomiso/` prefix)? Both hold the bytes as they
 * arrived, metadata included (PO decision D7), so both are read only under the
 * decomiso's own read rule (lib/infra/decomiso-evidence-access.ts).
 */
export function isDecomisoEvidencePath(storagePath: string): boolean {
  return (
    storagePath.startsWith(DECOMISO_EVIDENCE_ROW_PREFIX) ||
    storagePath.startsWith(LEGACY_DECOMISO_PREFIX)
  );
}
