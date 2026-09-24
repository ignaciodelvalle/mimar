"use server";

// travel-export.ts — thin shim over the travel export use-case (movilidad
// Fase 1, Capability 5). Mirrors app/actions/ppp-export-caba.ts.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { generateTravelExport } from "@/src/modules/pets/application/travel-export/generate-travel-export";
import type { GenerateTravelExportResult } from "@/src/modules/pets/application/travel-export/types";

export type { GenerateTravelExportResult };

// @no-auth-required: auth enforced inside the delegated use-case (requireUserOrRedirect() is the
// first call but returns {supabase,user} consumed throughout the function — lifting would require
// changing the use-case signature)
export async function generateTravelExportAction(
  petPublicToken: string,
): Promise<GenerateTravelExportResult> {
  return generateTravelExport(petPublicToken);
}
