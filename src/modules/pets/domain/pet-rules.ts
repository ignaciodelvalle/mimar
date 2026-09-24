// Pure business rules for the pets domain.
// Zero external imports — no @/db, drizzle-orm, or next imports allowed.
// Extracted from app/actions/pets.ts inline logic.

// ---------------------------------------------------------------------------
// Ownership role mapping
// ---------------------------------------------------------------------------

/**
 * Maps custodyKind to the ownerships.role value stored in the DB.
 * foster_in_transit → shelter_custody (vecino-helps-stray case from AGENTS.md).
 */
export function custodyKindToOwnershipRole(
  custodyKind: "owner" | "foster_in_transit",
): "owner" | "shelter_custody" {
  return custodyKind === "foster_in_transit" ? "shelter_custody" : "owner";
}

/**
 * Maps custodyKind to the custody_kind value in the pet_registered event payload.
 * Different from the ownership role — used for the immutable event log.
 */
export function custodyKindToRegisteredPayloadKind(
  custodyKind: "owner" | "foster_in_transit",
): "owner" | "shelter_custody_by_citizen" {
  return custodyKind === "foster_in_transit" ? "shelter_custody_by_citizen" : "owner";
}

// ---------------------------------------------------------------------------
// Chip implant site mapping — moved to lib/domain/microchip-implant-site.ts
// (2026-07-18 dependency-direction cleanup). The `events` module needed this
// same mapping to write petIdentifications as a side effect of processing a
// microchip event, which meant importing it from here created an events→pets
// cross-module edge for a helper neither module exclusively owns. It now
// lives outside src/modules/**, importable by both without an edge.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Update-path predicates
// ---------------------------------------------------------------------------

type UpdateFlags = {
  hasContentChanges: boolean;
  hasPhoto: boolean;
  flagChanged: boolean;
  /** ARCH-S: chip presence newly detected (was absent, now present). */
  chipNewlyAdded?: boolean;
};

/**
 * Returns true when absolutely nothing changed — no content diff, no photo,
 * no flag flip, and no new chip. Used to short-circuit the transaction.
 */
export function isNoOp(flags: UpdateFlags): boolean {
  return !flags.hasContentChanges && !flags.hasPhoto && !flags.flagChanged && !flags.chipNewlyAdded;
}

/**
 * Returns true when ONLY the emergencyInfoVisible flag changed (no content,
 * no photo). Flag-only changes persist the row but emit NO pet_profile_updated
 * event (see AGENTS.md → Core principles #2).
 */
export function isFlagOnlyChange(flags: UpdateFlags): boolean {
  return flags.flagChanged && !flags.hasContentChanges && !flags.hasPhoto;
}

/**
 * Returns true when the chip was absent before and is now present.
 * Used to decide whether to emit a microchip_implanted event on update.
 */
export function isChipNewlyAdded(args: {
  existingChipId: string | null;
  parsedChipId: string | null;
}): boolean {
  return !args.existingChipId && !!args.parsedChipId;
}

/**
 * Returns true when the pet was NOT a PPP breed and now IS.
 * Used to trigger ppp_registration_reminder notification.
 */
export function isBecamePPP(args: { existingPPP: boolean; newPPP: boolean }): boolean {
  return !args.existingPPP && args.newPPP;
}
