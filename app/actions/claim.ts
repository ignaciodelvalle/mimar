"use server";

// claim.ts — thin shim (strangler migration 30/61).
//
// Business logic moved to:
//   src/modules/pets/application/stub-claim/
//
// This file re-exports all originally-exported symbols (1 action + 1 type)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { claimStubProfile } from "@/src/modules/pets/application/stub-claim/claim-stub-profile";
import type { ClaimFormState } from "@/src/modules/pets/application/stub-claim/types";

export type { ClaimFormState };

// @no-auth-required: auth enforced inside the delegated use-case (auth.getUser() runs after the
// security-gate check that must precede it — lifting would reorder)
export async function claimStubProfileAction(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  return claimStubProfile(_previous, formData);
}
