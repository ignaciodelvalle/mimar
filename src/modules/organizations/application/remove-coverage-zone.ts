// Use-case: remove a coverage zone from an organization.
//
// Auth handled by caller (requireOrgAccessByToken + isManagerRole check).
// Ownership check is folded into DELETE WHERE — no TOCTOU window.

import type { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface RemoveCoverageZoneRepo {
  deleteCoverageScoped: OrgRepository["deleteCoverageScoped"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type RemoveCoverageZoneInput = {
  organizationId: string;
  coverageId: string;
};

type Deps = {
  repo: RemoveCoverageZoneRepo;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function removeCoverageZone(
  input: RemoveCoverageZoneInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo } = deps;

  // Ownership is folded into WHERE — no TOCTOU.
  const deleted = await repo.deleteCoverageScoped(input.coverageId, input.organizationId);

  if (deleted.length === 0) {
    return { ok: false, error: "Zona no encontrada." };
  }

  return { ok: true, value: {}, notifications: [] };
}
