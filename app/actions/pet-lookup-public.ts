"use server";

// pet-lookup-public.ts — thin shim (strangler migration 45/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/pets/application/public-lookup/
//
// This file re-exports all originally-exported symbols (1 action + 1 type)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { lookupPetForDenuncia } from "@/src/modules/pets/application/public-lookup/lookup-pet-for-denuncia";
import type { PublicLookupResult } from "@/src/modules/pets/application/public-lookup/types";

export type { PublicLookupResult };

// @no-auth-required: anonymous pet lookup — public search for denuncia filing requires no account
export async function lookupPetForDenunciaAction(query: string): Promise<PublicLookupResult> {
  return lookupPetForDenuncia(query);
}
