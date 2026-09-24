// Foster volunteer domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/foster-volunteers.ts validation/slot-math blocks.

import type {
  DomainResult,
  ProfileSnapshot,
  UpsertFosterVolunteerInput,
  VolunteerSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// D13 pre-conditions
// ---------------------------------------------------------------------------

/**
 * Validates whether a user's profile meets the D13 pre-conditions for
 * joining or updating the foster volunteer pool.
 */
export function validateD13PreConditions(profile: ProfileSnapshot): DomainResult {
  if (profile.accountType !== "personal" || profile.role !== "owner") {
    return {
      ok: false,
      error: "Solo cuentas personales con rol owner pueden inscribirse como voluntario.",
    };
  }
  if (!profile.dniVerified) {
    return { ok: false, error: "Verificá tu DNI antes de inscribirte como voluntario." };
  }
  if (!profile.displayName?.trim()) {
    return { ok: false, error: "Completá tu nombre antes de inscribirte." };
  }
  if (!profile.phone?.trim()) {
    return { ok: false, error: "Agregá tu teléfono antes de inscribirte." };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Upsert input validation (species required + maxDuration guard)
// ---------------------------------------------------------------------------

/**
 * Validates the species selection and maxDuration constraints for the upsert
 * volunteer action. Species guard only applies when status === 'active'.
 */
export function validateUpsertVolunteerInput(
  input: Pick<
    UpsertFosterVolunteerInput,
    "status" | "acceptsDogs" | "acceptsCats" | "acceptsOtherSpecies" | "maxDurationWeeks"
  >,
): DomainResult {
  if (
    input.status === "active" &&
    !input.acceptsDogs &&
    !input.acceptsCats &&
    !input.acceptsOtherSpecies
  ) {
    return { ok: false, error: "Elegí al menos una especie que aceptás." };
  }

  if (input.maxDurationWeeks != null && input.maxDurationWeeks < 0) {
    return { ok: false, error: "La duración máxima no puede ser negativa." };
  }

  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Slot math
// ---------------------------------------------------------------------------

type ComputeNewSlotsInput = {
  existing: VolunteerSnapshot | null;
  mode: "enroll" | "update_preferences_only";
};

/**
 * Computes the new availableSlots value for a foster volunteer upsert.
 *
 * INSERT branch (no existing row):
 *   - enroll → 1
 *   - update_preferences_only → 0
 *
 * UPDATE branch (existing row):
 *   - withdrawn + enroll → 1 (reset: re-joining with fresh capacity)
 *   - withdrawn + update_preferences_only → 0
 *   - active/paused + enroll → slots + 1
 *   - active/paused + update_preferences_only → slots unchanged
 */
export function computeNewSlots({ existing, mode }: ComputeNewSlotsInput): number {
  if (!existing) {
    // INSERT branch.
    return mode === "enroll" ? 1 : 0;
  }

  // UPDATE branch.
  if (existing.status === "withdrawn") {
    return mode === "enroll" ? 1 : 0;
  }

  // active or paused.
  return mode === "enroll" ? existing.availableSlots + 1 : existing.availableSlots;
}
