"use server";

// performed-by.ts — thin shim (strangler migration 60/61).
//
// Business logic moved to:
//   src/modules/search/application/performed-by/
//
// This file re-exports the type and provides thin Action wrappers so all
// existing UI importers and the parity test keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import type { SearchJurisdiction } from "@/lib/infra/performed-by-search";
import { searchVetsAndClinicsAction as _searchVetsAndClinicsAction } from "@/src/modules/search/application/performed-by/search-performed-by";

// ---------------------------------------------------------------------------
// Type re-export (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { SearchPerformedByResult } from "@/src/modules/search/application/performed-by/types";

// ---------------------------------------------------------------------------
// Action wrappers — auth-gated: guard here, module does the work
// ---------------------------------------------------------------------------

export async function searchVetsAndClinicsAction(input: {
  query: string;
  jurisdiction?: SearchJurisdiction;
}): Promise<Awaited<ReturnType<typeof _searchVetsAndClinicsAction>>> {
  const { user } = await requireUserOrRedirect();
  return _searchVetsAndClinicsAction(user.id, input);
}

// The rate-limit reset for tests is NOT re-exported here (A01-4): every export
// of this file is a production server action that deletes live throttle state.
// Tests import it from search-performed-by.ts, which carries no directive.
