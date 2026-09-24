// Foster proposal domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/foster-proposals.ts validation blocks.

import {
  type DomainResult,
  PROPOSAL_EXPIRY_DAYS,
  REJECTION_REASONS,
  type RejectionReason,
} from "./types";

// ---------------------------------------------------------------------------
// Rejection reason validation
// ---------------------------------------------------------------------------

export function validateRejectionReason(reason: string): DomainResult<RejectionReason> {
  if (!(REJECTION_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: "Motivo de rechazo inválido." };
  }
  return { ok: true, value: reason as RejectionReason };
}

// ---------------------------------------------------------------------------
// Proposal expiry
// ---------------------------------------------------------------------------

export function computeProposalExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// D17 co-foster gate
// ---------------------------------------------------------------------------

/**
 * Returns true when any active foster row does NOT allow co-foster,
 * meaning a new proposal must be blocked.
 */
export function isCoFosterBlocked(
  activeFosterRows: Array<{ allowCoFoster: boolean | null }>,
): boolean {
  if (activeFosterRows.length === 0) return false;
  return activeFosterRows.some((r) => !r.allowCoFoster);
}

// ---------------------------------------------------------------------------
// Duplicate pending guard
// ---------------------------------------------------------------------------

/**
 * Returns true when a duplicate pending proposal already exists for the
 * (org, volunteer, pet) triple, meaning a new proposal must be blocked.
 */
export function isDuplicatePendingBlocked(hasDuplicate: boolean): boolean {
  return hasDuplicate;
}
