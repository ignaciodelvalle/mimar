// Direct org-to-org custody handoff domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/transfer.ts validation blocks.

import { type DomainResult, TRANSFERABLE_SOURCE_ROLES, type TransferableRole } from "./types";

// ---------------------------------------------------------------------------
// Source role validation
// ---------------------------------------------------------------------------

export function validateTransferableSourceRole(role: string): DomainResult {
  if (!(TRANSFERABLE_SOURCE_ROLES as readonly string[]).includes(role)) {
    return {
      ok: false,
      error: `No se puede transferir un registro de rol "${role}". Solo shelter_custody u owner.`,
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// New role resolution — PARITY QUIRK: silent coercion to shelter_custody
// ---------------------------------------------------------------------------

/**
 * Resolves the new role for the destination ownership.
 * If the raw value is not in the transferable roles whitelist, silently falls
 * back to 'shelter_custody' WITHOUT returning an error. This preserves the
 * flag-without-error behavior from the original transferCustodyAction.
 */
export function resolveNewRole(newRoleRaw: string): TransferableRole {
  return (TRANSFERABLE_SOURCE_ROLES as readonly string[]).includes(newRoleRaw)
    ? (newRoleRaw as TransferableRole)
    : "shelter_custody";
}

// ---------------------------------------------------------------------------
// Destination-not-source guard
// ---------------------------------------------------------------------------

export function validateDestinationNotSource(
  sourceOrgId: string,
  destinationOrgId: string,
): DomainResult {
  if (destinationOrgId === sourceOrgId) {
    return {
      ok: false,
      error: "La organización destino no puede ser la misma que la actual.",
    };
  }
  return { ok: true, value: undefined };
}
