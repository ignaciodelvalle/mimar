// Use-case: add a coverage zone to an organization.
//
// Auth handled by caller (requireOrgAccessByToken + isManagerRole check).
// Caller resolves province code and locality list before calling.
//
// BY CATALOGUE ID (localidades-por-id D5). A zone is one of:
//   - the whole province (locality null);
//   - ONE catalogue locality, picked by id (`localityId`). The name stored is
//     that row's name; the id is what the id path reads. A name alone is
//     accepted only when it names exactly one live row of the province (its
//     id is then recorded); a name two localities share (Mechita, partido
//     Alberti and partido Bragado) is refused — the editor must send the id.
//   - ONE confirmed authority unit of the province (`unitId`), e.g. a whole
//     partido: authority_unit_id is recorded and the zone covers the unit's
//     member localities on the id path. A draft unit governs nothing (stage D
//     review W1); a provincial unit is the whole-province zone instead.
// The coverage flag stays on the name path until an operator flips it; these
// rows answer the same there as before (their name pair).

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
  /** A locality NAME (legacy clients); accepted only when unique in the province. */
  locality: string | null;
  /** The picked catalogue row (the editor sends this). */
  localityId?: string | null;
  /** A confirmed authority unit of the province, instead of a locality. */
  unitId?: string | null;
  /**
   * ISO province code (e.g. "AR-B"). Required when locality is non-null
   * to load the list of valid localities. When locality is null, this
   * field is not used but should still be provided for consistency.
   */
  provinceCode: string;
};

export type CoverageUnit = {
  id: string;
  name: string;
  provinceCode: string;
  kind: string;
  status: string;
};

type Deps = {
  repo: AddCoverageZoneRepo;
  listLocalitiesByProvince: (
    code: string,
  ) => Promise<{ name: string; id?: string; department?: string | null }[]>;
  validProvinces: ReadonlySet<string>;
  /** Loads a unit by id; required only when `unitId` is sent. */
  findUnit?: (unitId: string) => Promise<CoverageUnit | null>;
};

const NOT_IN_PROVINCE = "La localidad indicada no pertenece a la provincia seleccionada.";

type ZoneTarget = {
  locality: string | null;
  localityId: string | null;
  authorityUnitId: string | null;
};

/** What the zone names: the province, one catalogue row, or one confirmed unit. */
async function resolveZoneTarget(
  input: AddCoverageZoneInput,
  deps: Deps,
): Promise<ZoneTarget | { error: string }> {
  if (input.unitId) {
    const unit = deps.findUnit ? await deps.findUnit(input.unitId) : null;
    if (!unit || unit.provinceCode !== input.provinceCode) {
      return { error: "La unidad indicada no pertenece a la provincia seleccionada." };
    }
    if (unit.kind === "provincia") {
      return { error: "Para cubrir toda la provincia elegí «Toda la provincia»." };
    }
    if (unit.status !== "confirmed") {
      return { error: "Esa unidad todavía es una propuesta: no se le pueden asignar zonas." };
    }
    return { locality: unit.name, localityId: null, authorityUnitId: unit.id };
  }
  if (!input.localityId && input.locality === null) {
    return { locality: null, localityId: null, authorityUnitId: null };
  }
  const localities = await deps.listLocalitiesByProvince(input.provinceCode);
  if (input.localityId) {
    const row = localities.find((l) => l.id === input.localityId);
    if (!row) return { error: NOT_IN_PROVINCE };
    return { locality: row.name, localityId: input.localityId, authorityUnitId: null };
  }
  const matches = localities.filter((l) => l.name === input.locality);
  if (matches.length === 0) return { error: NOT_IN_PROVINCE };
  if (matches.length > 1) {
    return {
      error: "Hay más de una localidad con ese nombre en la provincia. Elegila de la lista.",
    };
  }
  return { locality: input.locality, localityId: matches[0]?.id ?? null, authorityUnitId: null };
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function addCoverageZone(
  input: AddCoverageZoneInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, validProvinces } = deps;

  // Validate province.
  if (!validProvinces.has(input.province)) {
    return { ok: false, error: "La provincia indicada no es válida." };
  }

  const target = await resolveZoneTarget(input, deps);
  if ("error" in target) return { ok: false, error: target.error };
  const { locality, localityId, authorityUnitId } = target;

  // Idempotency: reject duplicate zone (by id when there is one, else by name).
  const existing = await repo.findDupCoverage(input.organizationId, input.province, locality, {
    localityId,
    authorityUnitId,
  });
  if (existing) {
    return { ok: false, error: "Esa zona ya está registrada para esta organización." };
  }

  await repo.insertCoverage({
    organizationId: input.organizationId,
    province: input.province,
    locality,
    localityId,
    authorityUnitId,
    placeMethod: localityId ? "catalogue_id" : null,
  });

  return { ok: true, value: {}, notifications: [] };
}
