// Use-case: set a coverage zone as the primary zone for an organization.
//
// Auth handled by caller (requireOrgAccessByToken + isManagerRole check).
// Uses a transaction: clear all isPrimary flags first, then set the target
// (org-scoped WHERE — no TOCTOU window).

import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface SetPrimaryCoverageZoneRepo {
  clearPrimaryScoped: OrgRepository["clearPrimaryScoped"];
  setPrimaryScoped: OrgRepository["setPrimaryScoped"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type SetPrimaryCoverageZoneInput = {
  organizationId: string;
  coverageId: string;
};

type Deps = {
  repo: SetPrimaryCoverageZoneRepo;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function setPrimaryCoverageZone(
  input: SetPrimaryCoverageZoneInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, transaction } = deps;

  let found = false;

  await transaction(async (tx) => {
    const e = tx as Exec;

    // Clear all isPrimary flags for the org.
    await repo.clearPrimaryScoped(input.organizationId, e);

    // Set the target — scoped by both id AND organizationId.
    const updated = await repo.setPrimaryScoped(input.coverageId, input.organizationId, e);
    found = updated.length > 0;
  });

  if (!found) {
    return { ok: false, error: "Zona no encontrada." };
  }

  return { ok: true, value: {}, notifications: [] };
}
