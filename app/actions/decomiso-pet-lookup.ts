"use server";

// decomiso-pet-lookup.ts — thin shim (strangler migration 40/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/decomiso/application/decomiso-pet-lookup/
//
// This file re-exports all originally-exported symbols (1 action + 1 type)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";
import { lookupPetForDecomiso } from "@/src/modules/decomiso/application/decomiso-pet-lookup/lookup-pet-for-decomiso";
import type { GovtPetLookupResult } from "@/src/modules/decomiso/application/decomiso-pet-lookup/types";

export type { GovtPetLookupResult };

export async function lookupPetForDecomisoAction(query: string): Promise<GovtPetLookupResult> {
  const session = await requireDecomisoPrincipal();
  return lookupPetForDecomiso(session, query);
}
