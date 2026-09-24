// Pure storage-path builder for revocation/deactivation evidence uploads (C23).
//
// Lives in lib/ (not the "use client" form components) so the path convention
// is a single, unit-tested source of truth shared by the three evidence forms
// (DeactivateAdminForm, DeactivateGovtForm, RevokeLocalityRowActions).
//
// WHY TARGET-NAMESPACED (C23)
// ---------------------------
// The forms previously namespaced uploads by the ACTOR
//   `${actorUserId}/${timestamp}-...`
// which scattered a target's evidence across every operator who ever acted on
// it and made bucket-level cleanup/audit by target impossible. The path is now
// namespaced by the TARGET being acted on (the admin/govt user id, or the
// locality assignment id) so all evidence for one target lives under one prefix.
//
// Combined with uploading on SUBMIT (not on file-select), cancelling a form now
// never leaves orphaned objects in the `revocations` bucket.

/**
 * Build the storage object path for one evidence file.
 *
 * @param targetId  the entity being acted on (admin/govt user id or assignment id)
 * @param fileName  the original file name — only its extension is used
 * @param now       injectable clock (defaults to Date.now) for deterministic tests
 * @param rand      injectable randomness (defaults to a base36 suffix) for tests
 */
export function buildRevocationEvidencePath(
  targetId: string,
  fileName: string,
  now: () => number = Date.now,
  rand: () => string = () => Math.random().toString(36).slice(2),
): string {
  const ext = extractExtension(fileName);
  return `${targetId}/${now()}-${rand()}.${ext}`;
}

/** Extract a lowercase-safe file extension, defaulting to "bin" when absent. */
function extractExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  // No dot, or dot is the last char (trailing) → no usable extension.
  if (dot === -1 || dot === fileName.length - 1) return "bin";
  return fileName.slice(dot + 1);
}
