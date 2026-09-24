"use server";

// physical-tag-interest.ts — thin shim (strangler migration 53/61).
//
// Business logic moved to:
//   src/modules/pets/application/physical-tag-interest/
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requirePetAccess } from "@/lib/infra/pet-access";
import { togglePhysicalTagInterest } from "@/src/modules/pets/application/physical-tag-interest/toggle-physical-tag-interest";
import type { TogglePhysicalTagInterestResult } from "@/src/modules/pets/application/physical-tag-interest/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { TogglePhysicalTagInterestResult };

// ---------------------------------------------------------------------------
// Action wrapper — auth guard here, use-case receives authenticated context
// ---------------------------------------------------------------------------

export async function togglePhysicalTagInterestAction(
  petPublicToken: string,
): Promise<TogglePhysicalTagInterestResult> {
  const access = await requirePetAccess(petPublicToken);
  if (!access.ok) return { error: access.error };
  if (access.accessPath !== "owner") {
    return { error: "Solo el dueño legal puede manifestar interés en una chapa física." };
  }
  return togglePhysicalTagInterest(access.user.id, access.pet.id, petPublicToken);
}
