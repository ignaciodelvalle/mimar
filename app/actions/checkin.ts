"use server";

// checkin.ts — thin shim for the post-adoption check-in (strangler migration
// 33/61).
//
// The form adapter — cookie-door guard, field parsing, location
// canonicalisation, attachment upload and rollback — lives with the other pets
// controllers in src/modules/pets/actions.ts; the RULES live in
// src/modules/pets/application/checkin/. This file only keeps the import path
// the page and the form already use.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { recordPostAdoptionCheckinAction as _recordPostAdoptionCheckinAction } from "@/src/modules/pets/actions";
import type { CheckinFormState } from "@/src/modules/pets/application/checkin/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { CheckinFormState };

// ---------------------------------------------------------------------------
// Action wrapper — thin controller for the page binding
// ---------------------------------------------------------------------------

// @no-auth-required: delegates entirely to the pets-module action, which calls
// requirePetAccess (owner path only) before parsing, uploading or writing.
export async function recordPostAdoptionCheckinAction(
  publicToken: string,
  _previous: CheckinFormState,
  formData: FormData,
): Promise<CheckinFormState> {
  return _recordPostAdoptionCheckinAction(publicToken, _previous, formData);
}
