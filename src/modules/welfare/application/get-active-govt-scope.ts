// Helper: load the active govt jurisdiction rows for a user.
// Extracted from app/actions/welfare-triage.ts::getActiveGovtScopeForUser.
// Exported as a module helper (also re-exported from the shim for listing pages).
//
// Uses WelfareRepository.findGovtScopeForUser to keep the application layer
// free of direct Drizzle / @/db imports (hexagonal purity — W2 fix).

import { WelfareRepository } from "../infrastructure/welfare-repository";

export type GovtJurisdiction = {
  province: string;
  locality: string;
};

const repo = new WelfareRepository();

/**
 * Return all active (non-revoked) govt_assignments rows for `userId`.
 * Empty array for admins (callers use universal scope) or users with no
 * active assignments.
 */
export async function getActiveGovtScopeForUser(userId: string): Promise<GovtJurisdiction[]> {
  return repo.findGovtScopeForUser(userId);
}
