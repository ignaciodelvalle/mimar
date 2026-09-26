// The authority-unit seed plan and the partial-grant report
// (localidades-por-id C2, PO decisions D1 + D2; plan step 6: units from the
// official local government). Pure: no database, so the rules are unit-tested;
// scripts/seed-authority-units.ts feeds it the live catalogue and the committed
// local-government reference, and writes what it returns.
//
// D1 — who governs a locality:
//   - Buenos Aires: a department IS a partido, and a partido is a municipio
//     (the official gobierno_local of every Buenos Aires locality is its
//     partido: department 06007 → gobierno local 060007 — fenced on the
//     committed reference).
//   - CABA: ONE `ciudad` unit over every barrio (the barrios have no
//     department). Never a unit per barrio.
//   - Every other province: the OFFICIAL LOCAL GOVERNMENT of the locality
//     (Georef `gobierno_local_id`, lib/reference/locality-gobierno-local.json).
//     A department is not a government there — Córdoba has 427 local
//     governments in 26 departments. The unit is keyed
//     `gobierno_local:<province>:<id>`, named after the government, and its
//     kind follows the source's category (a Municipio is a `municipio`; a
//     comuna, comuna rural, comisión de fomento, comisión municipal or junta de
//     gobierno — a local government without municipal rank — is a `comuna`).
//   - A locality the reference names no government for, in a province where it
//     names some, gets NO municipal unit: the provincial unit covers it. That is
//     what the data says (Río Negro's "tierras de frontera", rural Tierra del
//     Fuego), and anything else would be a guess (P1).
//   - A province the reference names no government for at all falls back to
//     one `departamento` proposal per INDEC department, as before.
//   - Every province present gets one provincial unit. It has no explicit
//     members: it covers the whole province, unresolved places included.
//   - Every seeded unit is a DRAFT: the data being official is not the
//     authority being onboarded; a platform admin confirms each one (C4).
//   - A row the catalogue guard drops (whole-province aggregate, superseded
//     source) governs nothing and is left out.
//
// D2 — a grant that holds part of a unit is listed for confirmation and its
// access stays exactly as it is: widening access is a privacy act, so this
// module only reports.

import { provinceByCode } from "@/lib/reference/ar-provincias";
import {
  isSupersededByAltSource,
  isWholeProvinceAggregate,
} from "@/lib/reference/locality-integrity";

import type { AuthorityUnitKind, AuthorityUnitLevel } from "@/db/schema";

/** One live catalogue row, as the seed reads it. */
export type CatalogueLocality = {
  id: string;
  provinceCode: string;
  localityName: string;
  departmentCode: string | null;
  departmentName: string | null;
  source: string;
  /** INDEC census locality id; null for a CABA barrio or a manual row. */
  indecId: string | null;
};

export type PlannedUnit = {
  /** Natural key; what makes a re-run of the seed idempotent. */
  seedKey: string;
  kind: AuthorityUnitKind;
  level: AuthorityUnitLevel;
  provinceCode: string;
  name: string;
  indecDepartmentCode: string | null;
  parentSeedKey: string | null;
  /** Catalogue ids the unit governs; always empty for a provincial unit. */
  localityIds: string[];
};

export type AuthorityUnitPlan = {
  units: PlannedUnit[];
  /**
   * Rows the plan refuses to place where the unit comes from the department
   * (Buenos Aires, or a province with no local-government data): no department.
   */
  unplaced: CatalogueLocality[];
  /**
   * Rows of a province with local-government data that the reference names no
   * government for (or disputes). The provincial unit covers them; no
   * municipal unit is guessed.
   */
  withoutLocalGovernment: CatalogueLocality[];
  /**
   * Rows the catalogue guard drops (lint:locality-integrity): a whole-province
   * aggregate, or a row of a source another source supersedes for its
   * province (INDEC's AR-C rows under the 48 barrios). Not places anyone
   * governs; a membership would also pin a row the guard is about to drop.
   */
  excluded: CatalogueLocality[];
};

/** True when a catalogue row is a place an authority can govern. */
export function isGovernableLocality(
  row: Pick<CatalogueLocality, "provinceCode" | "localityName" | "departmentCode" | "source">,
): boolean {
  return !isWholeProvinceAggregate(row) && !isSupersededByAltSource(row);
}

/** The categories the official dataset uses (gobiernos_locales.csv). Closed. */
export const LOCAL_GOVERNMENT_CATEGORIES = [
  "Municipio",
  "Comuna",
  "Comuna Rural",
  "Comisión de Fomento",
  "Comisión Municipal",
  "Junta de Gobierno",
] as const;
export type LocalGovernmentCategory = (typeof LOCAL_GOVERNMENT_CATEGORIES)[number];

/**
 * The unit kind of each category, among the kinds the schema allows. Only a
 * Municipio is a `municipio`; every other category is a local government
 * without municipal rank, which the schema calls a `comuna`. All sit at
 * municipal level: each is the local government of its localities.
 */
export const KIND_OF_CATEGORY: Readonly<Record<LocalGovernmentCategory, AuthorityUnitKind>> = {
  Municipio: "municipio",
  Comuna: "comuna",
  "Comuna Rural": "comuna",
  "Comisión de Fomento": "comuna",
  "Comisión Municipal": "comuna",
  "Junta de Gobierno": "comuna",
};

/** Why the generator left a locality without a government. */
export type DisputeReason =
  | "sources-disagree"
  | "components-disagree"
  | "partially-covered"
  | "government-outside-province";

/** lib/reference/locality-gobierno-local.json, as the plan reads it. */
export type LocalGovernmentReference = {
  /** gobierno_local_id → [province ISO code, category, name]. */
  governments: Readonly<Record<string, readonly [string, LocalGovernmentCategory, string]>>;
  /** INDEC census locality id → gobierno_local_id. */
  localities: Readonly<Record<string, string>>;
  disputed: Readonly<Record<string, DisputeReason>>;
};

export const EMPTY_LOCAL_GOVERNMENTS: LocalGovernmentReference = {
  governments: {},
  localities: {},
  disputed: {},
};

export function localGovernmentSeedKey(provinceCode: string, gobiernoLocalId: string): string {
  return `gobierno_local:${provinceCode}:${gobiernoLocalId}`;
}

const CABA = "AR-C";
const BUENOS_AIRES = "AR-B";
export const CABA_CITY_NAME = "Ciudad Autónoma de Buenos Aires";

export function provincialSeedKey(provinceCode: string): string {
  return `provincia:${provinceCode}`;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The official local government's unit for a row, or null when the reference names none. */
function localGovernmentUnit(
  row: CatalogueLocality,
  reference: LocalGovernmentReference,
  parentSeedKey: string,
): Omit<PlannedUnit, "localityIds"> | null {
  const gid = row.indecId ? reference.localities[row.indecId] : undefined;
  const gov = gid ? reference.governments[gid] : undefined;
  // A government of another province is never a unit here (the generator
  // already refuses one; this holds the plan to it on any input).
  if (!gid || !gov || gov[0] !== row.provinceCode) return null;
  return {
    seedKey: localGovernmentSeedKey(row.provinceCode, gid),
    kind: KIND_OF_CATEGORY[gov[1]],
    level: "municipal",
    provinceCode: row.provinceCode,
    name: gov[2],
    indecDepartmentCode: null,
    parentSeedKey,
  };
}

export function planAuthorityUnits(
  catalogue: readonly CatalogueLocality[],
  reference: LocalGovernmentReference,
): AuthorityUnitPlan {
  const rows = [...catalogue].sort((a, b) => byString(a.id, b.id));
  const units = new Map<string, PlannedUnit>();
  const unplaced: CatalogueLocality[] = [];
  const withoutLocalGovernment: CatalogueLocality[] = [];
  const excluded: CatalogueLocality[] = [];
  // The provinces whose units come from the local government.
  const byGovernment = new Set(Object.values(reference.governments).map(([province]) => province));

  const provincial = (provinceCode: string): string => {
    const key = provincialSeedKey(provinceCode);
    if (!units.has(key)) {
      units.set(key, {
        seedKey: key,
        kind: "provincia",
        level: "provincial",
        provinceCode,
        name: provinceByCode(provinceCode)?.name ?? provinceCode,
        indecDepartmentCode: null,
        parentSeedKey: null,
        localityIds: [],
      });
    }
    return key;
  };

  for (const row of rows) {
    if (!isGovernableLocality(row)) {
      excluded.push(row);
      continue;
    }
    const parent = provincial(row.provinceCode);
    let unit: Omit<PlannedUnit, "localityIds">;
    if (row.provinceCode === CABA) {
      unit = {
        seedKey: `ciudad:${CABA}`,
        kind: "ciudad",
        level: "municipal",
        provinceCode: CABA,
        name: CABA_CITY_NAME,
        indecDepartmentCode: null,
        parentSeedKey: parent,
      };
    } else if (row.provinceCode !== BUENOS_AIRES && byGovernment.has(row.provinceCode)) {
      const governed = localGovernmentUnit(row, reference, parent);
      if (!governed) {
        withoutLocalGovernment.push(row);
        continue;
      }
      unit = governed;
    } else if (row.departmentCode) {
      const kind: AuthorityUnitKind =
        row.provinceCode === BUENOS_AIRES ? "municipio" : "departamento";
      unit = {
        seedKey: `${kind}:${row.provinceCode}:${row.departmentCode}`,
        kind,
        level: "municipal",
        provinceCode: row.provinceCode,
        name: row.departmentName?.trim() || `Departamento ${row.departmentCode}`,
        indecDepartmentCode: row.departmentCode,
        parentSeedKey: parent,
      };
    } else {
      unplaced.push(row);
      continue;
    }
    const existing = units.get(unit.seedKey);
    if (existing) existing.localityIds.push(row.id);
    else units.set(unit.seedKey, { ...unit, localityIds: [row.id] });
  }

  return {
    units: [...units.values()].sort((a, b) => byString(a.seedKey, b.seedKey)),
    unplaced,
    withoutLocalGovernment,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// D2 — the grant coverage report
// ---------------------------------------------------------------------------

/** One active govt_assignments row, as the report reads it. */
export type GrantForReport = {
  id: string;
  userId: string;
  /** Canonical province name (CHECK 0055). */
  province: string;
  /** The granted locality name; '' for a whole-province grant. */
  locality: string;
  /** The catalogue row the admin picked (0246); NULL for legacy name-only rows. */
  localityId: string | null;
};

export type UnitHolding = { userId: string; unitId: string; held: number; unitSize: number };

export type GrantCoverageReport = {
  /** An operator holding PART of a unit: listed for confirmation, never widened. */
  partial: Array<UnitHolding & { grantIds: string[] }>;
  /** An operator holding every locality of a unit. */
  complete: UnitHolding[];
  /** The whole-province sentinels ('' and the CABA city literal). */
  wholeProvince: GrantForReport[];
  /** No catalogue id, or an id no unit governs: cannot be mapped without guessing. */
  unmapped: GrantForReport[];
};

/** The whole-province spellings a grant row carries today (R10). */
export function isWholeProvinceGrant(g: Pick<GrantForReport, "province" | "locality">): boolean {
  return g.locality === "" || (g.province === "CABA" && g.locality === CABA_CITY_NAME);
}

/**
 * Sort every active grant against the unit membership.
 *
 * `unitOfLocality`: locality id -> the unit governing it (active, municipal).
 * `unitSize`: unit id -> how many localities it governs today.
 */
export function reportGrantCoverage(
  grants: readonly GrantForReport[],
  unitOfLocality: ReadonlyMap<string, string>,
  unitSize: ReadonlyMap<string, number>,
): GrantCoverageReport {
  const wholeProvince: GrantForReport[] = [];
  const unmapped: GrantForReport[] = [];
  const held = new Map<
    string,
    { userId: string; unitId: string; grantIds: string[]; localities: Set<string> }
  >();

  for (const g of grants) {
    if (isWholeProvinceGrant(g)) {
      wholeProvince.push(g);
      continue;
    }
    const unitId = g.localityId ? unitOfLocality.get(g.localityId) : undefined;
    if (!unitId) {
      unmapped.push(g);
      continue;
    }
    const key = `${g.userId}\u0000${unitId}`;
    const entry = held.get(key) ?? {
      userId: g.userId,
      unitId,
      grantIds: [],
      localities: new Set<string>(),
    };
    entry.grantIds.push(g.id);
    entry.localities.add(g.localityId as string);
    held.set(key, entry);
  }

  const partial: GrantCoverageReport["partial"] = [];
  const complete: UnitHolding[] = [];
  for (const entry of [...held.values()].sort(
    (a, b) => byString(a.userId, b.userId) || byString(a.unitId, b.unitId),
  )) {
    const size = unitSize.get(entry.unitId) ?? 0;
    const count = entry.localities.size;
    if (count >= size) {
      complete.push({ userId: entry.userId, unitId: entry.unitId, held: count, unitSize: size });
    } else {
      partial.push({
        userId: entry.userId,
        unitId: entry.unitId,
        held: count,
        unitSize: size,
        grantIds: [...entry.grantIds].sort(byString),
      });
    }
  }

  return { partial, complete, wholeProvince, unmapped };
}
