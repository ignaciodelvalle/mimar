// Pure helper: shapes an audit log entry for display.
//
// Centralises all payload field extraction so:
//   - magic_link is NEVER exposed (security; operator_credentials_reset PII)
//   - evidence count is derived once
//   - the magic_link exclusion is testable in isolation
//
// RSC pages import this; unit tests cover every case without a DB.

import { auditActionLabel } from "@/lib/ui/audit-action-labels";

export interface AuditEntryView {
  /** Human-readable es-AR action label */
  label: string;
  /** Reason / motivo text, if present in payload */
  reason?: string;
  /** Number of evidence files attached, if present */
  evidenceCount?: number;
  /** Reset method (e.g. "magic_link"), for operator_credentials_reset — never the link itself */
  resetMethod?: string;
}

/**
 * Derives a display-safe view from an audit log row's action + payload.
 *
 * - magic_link is intentionally excluded (PII/security).
 * - payload is typed as `unknown` because it arrives from jsonb.
 */
export function describeAuditEntry(action: string, payload: unknown): AuditEntryView {
  const label = auditActionLabel(action);

  // Guard: payload must be a plain object to read fields from
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { label };
  }

  const p = payload as Record<string, unknown>;

  const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : undefined;

  const evidenceCount =
    Array.isArray(p.evidence_attachment_ids) && p.evidence_attachment_ids.length > 0
      ? p.evidence_attachment_ids.length
      : undefined;

  // For operator_credentials_reset expose only "method", never the link itself.
  // magic_link is explicitly excluded from this view regardless of action type.
  const resetMethod =
    action === "operator_credentials_reset" && typeof p.method === "string" ? p.method : undefined;

  return { label, reason, evidenceCount, resetMethod };
}
