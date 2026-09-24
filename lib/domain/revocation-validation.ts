// Pure validation helpers for revocation/deactivation server actions.
//
// Lives in lib/ (not app/actions/) because Next.js requires every export in
// a "use server" file to be an async function. These helpers are sync, pure,
// and reused across admin-revocations.ts and admin-institutional.ts (ADR-5).

/** Minimum length for an action-reason (reused by reset-credentials friction). */
export const MOTIVO_MIN = 30;
const MOTIVO_MAX = 2000;

export function validateMotivoAndAttachments(
  motivo: string,
  attachmentIds: string[],
): { error: string } | null {
  const trimmed = motivo.trim();
  if (trimmed.length < MOTIVO_MIN) return { error: "REASON_TOO_SHORT" };
  if (trimmed.length > MOTIVO_MAX) return { error: "REASON_TOO_LONG" };
  if (attachmentIds.length === 0) return { error: "EVIDENCE_REQUIRED" };
  return null;
}
