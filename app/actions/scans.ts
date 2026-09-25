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

import { logScan as _logScan } from "@/src/modules/pets/application/scans/log-scan";

// @no-auth-required: auth is optional and handled inside the delegated use-case after
// pet-existence check — anonymous scans are valid; auth.getUser() is used only to flag self-scans
//
// W8 (PO, 2026-09-24): no device GPS anywhere on the web — this action takes
// no coordinate parameter at all any more; a client cannot pass one even by
// crafting the request by hand.
export async function logScanAction(publicToken: string): Promise<void> {
  return _logScan(publicToken);
}
