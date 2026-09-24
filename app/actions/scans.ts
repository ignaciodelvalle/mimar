"use server";

// scans.ts — thin shim (strangler migration 58/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/pets/application/scans/
//
// This file re-exports all originally-exported symbols with identical
// signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function.

import {
  type ScanCoords,
  logScan as _logScan,
} from "@/src/modules/pets/application/scans/log-scan";

// @no-auth-required: auth is optional and handled inside the delegated use-case after
// pet-existence check — anonymous scans are valid; auth.getUser() is used only to flag self-scans
//
// `coords` is only ever sent by ScanLogger after an explicit browser-geolocation
// grant on a lost pet's page. The use-case re-validates the values and re-checks
// pet.status === 'lost' server-side, so a forged call cannot attach GPS to a
// non-lost pet (Task #45 privacy contract).
export async function logScanAction(publicToken: string, coords?: ScanCoords): Promise<void> {
  return _logScan(publicToken, coords ? { coords } : undefined);
}
