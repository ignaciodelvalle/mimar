"use server";

// localities.ts — thin shim (strangler migration 46/61).
//
// Business logic moved to:
//   src/modules/localities/application/search/
//
// This file re-exports the type and provides thin Action wrappers so all
// existing UI importers and the parity test keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  searchLocalitiesAction as _searchLocalitiesAction,
  searchLocalitiesPublicAction as _searchLocalitiesPublicAction,
} from "@/src/modules/localities/application/search/search-localities";
import type { SearchLocalitiesResult } from "@/src/modules/localities/application/search/types";

// ---------------------------------------------------------------------------
// Type re-export (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { SearchLocalitiesResult };

// ---------------------------------------------------------------------------
// Action wrappers — auth-gated variant: guard here, module does the work
// ---------------------------------------------------------------------------

export async function searchLocalitiesAction(input: {
  provinceCode?: string;
  query: string;
}): Promise<SearchLocalitiesResult> {
  const { user } = await requireUserOrRedirect();
  return _searchLocalitiesAction(user.id, input);
}

// @no-auth-required: ar_localities is public INDEC reference data (locality
// names only, no PII). Rate-limited via the shared __public__ bucket. Powers the
// public filter typeaheads (perdidas / adoptar) where there is no session.
export async function searchLocalitiesPublicAction(
  ...args: Parameters<typeof _searchLocalitiesPublicAction>
): Promise<SearchLocalitiesResult> {
  return _searchLocalitiesPublicAction(...args);
}

// The rate-limit reset for tests is NOT re-exported here (A01-4): every export
// of this file is a production server action, and that one deleted the live
// throttle behind the anonymous typeahead. Tests import it from
// search-localities.ts, which carries no directive.
