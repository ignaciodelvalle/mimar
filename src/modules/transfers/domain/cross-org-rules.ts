// Cross-org transfer domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/cross-org-transfer.ts validation blocks.
// SECURITY NOTE: validateReceiverOrgScope is the auth boundary for cross-org
// accept/reject. The canonical-org resolution (case col ?? payload) with drift
// detection must be reproduced exactly — do NOT simplify.

import { CROSS_ORG_ALLOWED_REASONS, type DomainResult } from "./types";

// ---------------------------------------------------------------------------
// Reason validation
// ---------------------------------------------------------------------------

export function validateCrossOrgReason(input: {
  reason: string;
  notes: string | null | undefined;
}): DomainResult {
  if (!CROSS_ORG_ALLOWED_REASONS.has(input.reason)) {
    return { ok: false, error: "Motivo de transferencia inválido." };
  }
  if (input.reason === "other") {
    const trimmedNotes = input.notes?.trim() || null;
    if (!trimmedNotes) {
      return { ok: false, error: "El motivo 'other' requiere una nota explicativa." };
    }
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Source custody must not be a rehome sponsorship (rehome-by-titular, REQ-15)
// ---------------------------------------------------------------------------

/**
 * The refusal every sponsored-custody writer shows. One sentence, whichever
 * layer says it (propose pre-read, accept under the lock).
 */
export const SPONSORED_CUSTODY_TRANSFER_ERROR =
  "Esta custodia es un acompañamiento de adopción: el animal vive con su titular y solo el titular puede darlo de baja. No se puede transferir a otra organización.";

/**
 * A `shelter_custody` row opened by a titular's consent (rehome-by-titular)
 * is not the org's to hand off. Spec REQ-15: only the titular's withdraw, a
 * decline before acceptance or a completed adoption end a sponsorship — an
 * org-to-org transfer is none of those. Letting it through would also leave
 * the receiver holding custody beside the titular's owner row with no
 * `rehome_sponsorship_started` naming that row, so the titular's withdraw
 * (which keys on the spine) could never find it: REQ-10's unconditional
 * route back would be gone.
 *
 * Keyed on the spine's `ownership_id`, never on the owner+shelter_custody
 * shape: a sponsorship pointing at a DIFFERENT row than the sender's live one
 * is drift for lint:spine to report, not a reason to block an unrelated
 * hand-off.
 */
export function validateSourceNotSponsored(input: {
  sourceCustodyId: string;
  openSponsorship: { ownershipId: string } | null;
}): DomainResult {
  if (input.openSponsorship && input.openSponsorship.ownershipId === input.sourceCustodyId) {
    return { ok: false, error: SPONSORED_CUSTODY_TRANSFER_ERROR };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Open custody dispute (M-10)
// ---------------------------------------------------------------------------

/**
 * The refusal both cross-org layers show when the pet is under an open custody
 * dispute. One sentence, whichever layer says it — the propose pre-read or the
 * accept under the lock — the same shape REQ-15's refusal already uses.
 *
 * Why the accept needs it at all: propose checks, accept did not, and a
 * handshake stays open for 30 days. A dispute opened inside that window let the
 * animal change institution anyway, and the dispute's resolution then named as
 * "previous holder" an institution that was never party to the case. The spine
 * is append-only, so that misattribution cannot be corrected. The P2P twin got
 * this guard as TR-C1 (CRITICAL, fixed); the cross-org twin never did.
 *
 * NOT `validatePetStatusForTransfer`: that validator's `lost` arm would refuse
 * legitimate org-to-org hand-offs — a shelter passing a still-unclaimed found
 * animal to another shelter is the normal case here, not an error.
 */
export const OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR =
  "No podés transferir una mascota con disputa de custodia en curso.";

// ---------------------------------------------------------------------------
// Receiver-not-sender guard
// ---------------------------------------------------------------------------

export function validateReceiverNotSender(
  senderOrgId: string,
  receiverOrgId: string,
): DomainResult {
  if (receiverOrgId === senderOrgId) {
    return { ok: false, error: "El destinatario no puede ser tu propia organización." };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Org token match (edge-level auth guard for propose/accept/reject/cancel)
// ---------------------------------------------------------------------------

export function validateOrgTokenMatch(
  orgToken: string,
  inputToken: string,
  side: "sender" | "receiver",
): DomainResult {
  if (orgToken !== inputToken) {
    return {
      ok: false,
      error: `Estás operando desde una organización distinta a la ${side}.`,
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Canonical sender resolution with drift detection
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical sender org id: case column is source of truth,
 * payload is the fallback for legacy rows pre-backfill.
 * When both are present they must agree — drift here surfaces as an error
 * rather than silently authorizing the wrong sender.
 */
export function validateSenderOrgScope(args: {
  caseOpenedByOrganizationId: string | null | undefined;
  payloadFromOrganizationId: string | null | undefined;
}): DomainResult<{ canonicalSenderOrgId: string }> {
  const { caseOpenedByOrganizationId, payloadFromOrganizationId } = args;

  if (caseOpenedByOrganizationId && payloadFromOrganizationId) {
    if (caseOpenedByOrganizationId !== payloadFromOrganizationId) {
      return {
        ok: false,
        error:
          "Inconsistencia entre el caso y la propuesta. Avisanos para reconciliarlo antes de aceptar la transferencia.",
      };
    }
    return { ok: true, value: { canonicalSenderOrgId: caseOpenedByOrganizationId } };
  }

  const canonicalSenderOrgId = caseOpenedByOrganizationId ?? payloadFromOrganizationId ?? null;
  if (!canonicalSenderOrgId) {
    return { ok: false, error: "Propuesta sin organización emisora." };
  }

  return { ok: true, value: { canonicalSenderOrgId } };
}

// ---------------------------------------------------------------------------
// Canonical receiver resolution with drift detection — SECURITY BOUNDARY
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical receiver org id: case column is source of truth
 * (migration 0043), payload is fallback for legacy rows pre-backfill.
 * When both present and they disagree → drift error (inconsistency).
 * When resolved, validates that callerOrgId matches the canonical receiver.
 *
 * This is a CRITICAL security boundary equivalent to the foster-bug class:
 * the receiver auth is the case's receiverOrganizationId column, NOT the
 * caller's mere capability.
 */
export function validateReceiverOrgScope(args: {
  caseReceiverOrganizationId: string | null | undefined;
  payloadToOrganizationId: string | null | undefined;
  callerOrgId: string;
}): DomainResult<{ canonicalReceiverOrgId: string }> {
  const { caseReceiverOrganizationId, payloadToOrganizationId, callerOrgId } = args;

  if (caseReceiverOrganizationId && payloadToOrganizationId) {
    if (caseReceiverOrganizationId !== payloadToOrganizationId) {
      return {
        ok: false,
        error:
          "Inconsistencia entre el caso y la propuesta. Avisanos para reconciliarlo antes de aceptar la transferencia.",
      };
    }
  }

  const canonicalReceiverOrgId = caseReceiverOrganizationId ?? payloadToOrganizationId ?? null;
  if (!canonicalReceiverOrgId) {
    return { ok: false, error: "Propuesta sin organización destinataria." };
  }

  if (canonicalReceiverOrgId !== callerOrgId) {
    return { ok: false, error: "La propuesta no fue dirigida a tu organización." };
  }

  return { ok: true, value: { canonicalReceiverOrgId } };
}

// ---------------------------------------------------------------------------
// Duplicate-proposal guard (LIMIT-2, fail-loud)
// ---------------------------------------------------------------------------

/**
 * Validates the proposal event count fetched with LIMIT 2.
 * - 0 events: original proposal not found.
 * - 1 event: correct — proceed.
 * - 2 events: shadow/duplicate event detected — fail loud (do NOT silently
 *   pick one). The inconsistency must be reconciled manually.
 */
export function validateDuplicateProposalGuard(proposalEventCount: number): DomainResult {
  if (proposalEventCount === 0) {
    return { ok: false, error: "Propuesta original no encontrada." };
  }
  if (proposalEventCount >= 2) {
    return {
      ok: false,
      error:
        "El caso tiene propuestas duplicadas. Avisanos para reconciliarlo antes de aceptar la transferencia.",
    };
  }
  return { ok: true, value: undefined };
}
