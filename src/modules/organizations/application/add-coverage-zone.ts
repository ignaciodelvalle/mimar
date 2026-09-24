// Use-case: add a coverage zone to an organization.
//
// Auth handled by caller (requireOrgAccessByToken + isManagerRole check).
// Caller resolves province code and locality list before calling.

import type { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface AddCoverageZoneRepo {
  findDupCoverage: OrgRepository["findDupCoverage"];
  insertCoverage: OrgRepository["insertCoverage"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type AddCoverageZoneInput = {
  organizationId: string;
  province: string;
  locality: string | null;
  /**
   * ISO province code (e.g. "AR-B"). Required when locality is non-null
   * to load the list of valid localities. When locality is null, this
   * field is not used but should still be provided for consistency.
   */
  provinceCode: string;
};

type Deps = {
  repo: AddCoverageZoneRepo;
  listLocalitiesByProvince: (code: string) => Promise<{ name: string }[]>;
  validProvinces: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function addCoverageZone(
  input: AddCoverageZoneInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, listLocalitiesByProvince, validProvinces } = deps;

  // Validate province.
  if (!validProvinces.has(input.province)) {
    return { ok: false, error: "La provincia indicada no es válida." };
  }

  // Validate locality belongs to province (only when locality is non-null).
  if (input.locality !== null) {
    const localities = await listLocalitiesByProvince(input.provinceCode);
    const match = localities.find((l) => l.name === input.locality);
    if (!match) {
      return {
        ok: false,
        error: "La localidad indicada no pertenece a la provincia seleccionada.",
      };
    }
  }

  // Idempotency: reject duplicate (org, province, locality).
  const existing = await repo.findDupCoverage(input.organizationId, input.province, input.locality);
  if (existing) {
    return { ok: false, error: "Esa zona ya está registrada para esta organización." };
  }

  await repo.insertCoverage({
    organizationId: input.organizationId,
    province: input.province,
    locality: input.locality,
  });

  return { ok: true, value: {}, notifications: [] };
}
