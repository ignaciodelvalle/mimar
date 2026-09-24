"use server";

// sign-timeline-attachments.ts — thin shim (strangler migration 43/61).
//
// Business logic moved to:
//   src/modules/pets/application/timeline-attachments/
//
// This file re-exports signTimelineAttachmentsForPet (used by
// mis-mascotas/[publicToken]/page.tsx) and signTimelineAttachments (used by
// the test suite) so all importers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import {
  signTimelineAttachments as _signTimelineAttachments,
  signTimelineAttachmentsForPet as _signTimelineAttachmentsForPet,
} from "@/src/modules/pets/application/timeline-attachments/sign-timeline-attachments";
import type { SignTimelineAttachmentsResult } from "@/src/modules/pets/application/timeline-attachments/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { SignTimelineAttachmentsResult } from "@/src/modules/pets/application/timeline-attachments/types";

// ---------------------------------------------------------------------------
// Writer re-exports — async wrappers (required by "use server" module contract)
// ---------------------------------------------------------------------------

// @no-auth-required: delegates entirely to signTimelineAttachments which calls
// requirePetAccess before touching the DB. This wrapper exists only to adapt
// the return type (Record<string,string> vs Record|{error}) for page.tsx binding.
export async function signTimelineAttachmentsForPet(
  petPublicToken: string,
  eventIds: string[],
): Promise<Record<string, string>> {
  return _signTimelineAttachmentsForPet(petPublicToken, eventIds);
}

// @no-auth-required: auth enforced inside the delegated use-case (requirePetAccess
// runs after input validation + empty-list short-circuit that must precede it —
// lifting would reorder the validation-before-auth control flow of the original).
export async function signTimelineAttachments(
  petPublicToken: string,
  eventIds: string[],
): Promise<SignTimelineAttachmentsResult> {
  return _signTimelineAttachments(petPublicToken, eventIds);
}
