"use server";

// public.ts — thin shim (strangler migration 44/61).
//
// Business logic moved to:
//   src/modules/pets/application/public/
//
// This file re-exports the PublicActionState type and provides the thin
// notifyOwnerOfFoundPetAction wrapper (used by UI components) that delegates
// to the use-case. There is no auth guard — this is an anonymous action
// (@no-auth-required); anyone scanning a QR can invoke it.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { notifyOwnerOfFoundPet } from "@/src/modules/pets/application/public/notify-owner-of-found-pet";
import type { PublicActionState } from "@/src/modules/pets/application/public/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { PublicActionState };

// ---------------------------------------------------------------------------
// Action wrapper — thin controller for UI components
// ---------------------------------------------------------------------------

// @no-auth-required: anonymous "found pet" notification — anyone scanning a QR can invoke it
export async function notifyOwnerOfFoundPetAction(
  publicToken: string,
  _previous: PublicActionState,
  formData: FormData,
): Promise<PublicActionState> {
  return notifyOwnerOfFoundPet(publicToken, _previous, formData);
}
