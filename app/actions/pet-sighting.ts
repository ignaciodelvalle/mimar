"use server";

// pet-sighting.ts — thin shim (strangler migration 29/61).
//
// Business logic moved to:
//   src/modules/pets/application/sighting/
//
// This file re-exports the SightingActionState type and provides the thin
// reportPetSightingAction wrapper (used by UI components) that delegates to
// the use-case. There is no auth guard — sighting is an anonymous action
// (@no-auth-required); the use-case receives the full set of raw arguments.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { reportPetSighting } from "@/src/modules/pets/application/sighting/report-pet-sighting";
import type { SightingActionState } from "@/src/modules/pets/application/sighting/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { SightingActionState };

// ---------------------------------------------------------------------------
// Action wrapper — thin controller for UI components
// ---------------------------------------------------------------------------

// @no-auth-required: anonymous sighting report — no account needed to report a found pet
export async function reportPetSightingAction(
  publicToken: string,
  _previous: SightingActionState,
  formData: FormData,
): Promise<SightingActionState> {
  return reportPetSighting(publicToken, _previous, formData);
}
