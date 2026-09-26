// The authority-unit seed plan (localidades-por-id C2, PO decisions D1 + D2;
// plan step 6: units from the official local government).
//
// D1: a Buenos Aires partido is a municipio; CABA is ONE ciudad unit over every
// barrio; everywhere else the unit is the OFFICIAL LOCAL GOVERNMENT of the
// locality (lib/reference/locality-gobierno-local.json), and a locality the
// reference names none for is covered by its province alone — never guessed.
// A province with no local-government data at all falls back to one
// `departamento` proposal per department. Every province gets one provincial
// unit with no explicit members.
// D2: a grant holding part of a unit is LISTED for confirmation, never widened.

import { describe, expect, it } from "vitest";

import {
  type CatalogueLocality,
  EMPTY_LOCAL_GOVERNMENTS,
  type GrantForReport,
  type LocalGovernmentReference,
  planAuthorityUnits,
  reportGrantCoverage,
} from "./authority-units-plan";

function loc(
  id: string,
  provinceCode: string,
  localityName: string,
  departmentCode: string | null,
  departmentName: string | null,
  indecId: string | null = null,
): CatalogueLocality {
  const source = provinceCode === "AR-C" ? "caba_open_data" : "indec_cppdyl";
  return { id, provinceCode, localityName, departmentCode, departmentName, source, indecId };
}

// Mechita exists in partido Alberti AND partido Bragado (Buenos Aires); Villa
// María exists in Buenos Aires (Alberti) and Córdoba (General San Martín).
// Córdoba's department General San Martín holds several local governments:
// Villa María, Villa Nueva (which also governs Sanabria), and none at all for
// Las Mojarras. Mendoza's department La Paz IS the municipio La Paz.
const CATALOGUE: CatalogueLocality[] = [
  loc("ba-mechita-alberti", "AR-B", "Mechita", "06021", "Alberti", "06021030"),
  loc("ba-villa-maria", "AR-B", "Villa María", "06021", "Alberti", "06021060"),
  loc("ba-mechita-bragado", "AR-B", "Mechita", "06112", "Bragado", "06112080"),
  loc("cba-villa-maria", "AR-X", "Villa María", "14042", "General San Martín", "14042170"),
  loc("cba-villa-nueva", "AR-X", "Villa Nueva", "14042", "General San Martín", "14042180"),
  loc("cba-sanabria", "AR-X", "Sanabria", "14042", "General San Martín", "14042120"),
  loc("cba-las-mojarras", "AR-X", "Las Mojarras", "14042", "General San Martín", "14042090"),
  loc("mza-la-paz", "AR-M", "La Paz", "50042", "La Paz", "50042020"),
  loc("mza-desaguadero", "AR-M", "Desaguadero", "50042", "La Paz", "50042010"),
  loc("caba-palermo", "AR-C", "Palermo", null, null),
  loc("caba-recoleta", "AR-C", "Recoleta", null, null),
  loc("caba-belgrano-r", "AR-C", "Belgrano R", null, null),
];

const REFERENCE: LocalGovernmentReference = {
  governments: {
    "060021": ["AR-B", "Municipio", "Alberti"],
    "140357": ["AR-X", "Municipio", "Villa María"],
    "140364": ["AR-X", "Municipio", "Villa Nueva"],
    "500042": ["AR-M", "Municipio", "La Paz"],
  },
  localities: {
    "06021030": "060021",
    "14042170": "140357",
    "14042180": "140364",
    "14042120": "140364",
    "50042020": "500042",
    "50042010": "500042",
  },
  disputed: {},
};

function unitOf(plan: ReturnType<typeof planAuthorityUnits>, localityId: string) {
  const units = plan.units.filter((u) => u.localityIds.includes(localityId));
  expect(units, `${localityId} must sit in exactly one planned unit`).toHaveLength(1);
  return units[0];
}

describe("planAuthorityUnits", () => {
  it("CABA is one ciudad unit over every barrio, never a unit per barrio", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    const caba = plan.units.filter((u) => u.provinceCode === "AR-C" && u.level !== "provincial");
    expect(caba).toHaveLength(1);
    expect(caba[0]).toMatchObject({
      seedKey: "ciudad:AR-C",
      kind: "ciudad",
      level: "municipal",
      name: "Ciudad Autónoma de Buenos Aires",
      parentSeedKey: "provincia:AR-C",
    });
    expect([...(caba[0]?.localityIds ?? [])].sort()).toEqual([
      "caba-belgrano-r",
      "caba-palermo",
      "caba-recoleta",
    ]);
  });

  it("CABA stays one ciudad unit even when the reference names governments there", () => {
    const withComunas: LocalGovernmentReference = {
      ...REFERENCE,
      governments: { ...REFERENCE.governments, "022007": ["AR-C", "Comuna", "Comuna 1"] },
    };
    const plan = planAuthorityUnits(CATALOGUE, withComunas);
    const caba = plan.units.filter((u) => u.provinceCode === "AR-C" && u.level !== "provincial");
    expect(caba.map((u) => u.seedKey)).toEqual(["ciudad:AR-C"]);
  });

  it("homonyms split by unit, within and across provinces", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    const alberti = unitOf(plan, "ba-mechita-alberti");
    const bragado = unitOf(plan, "ba-mechita-bragado");
    expect(alberti?.seedKey).not.toBe(bragado?.seedKey);
    expect(unitOf(plan, "ba-villa-maria")?.seedKey).toBe(alberti?.seedKey);
    expect(unitOf(plan, "cba-villa-maria")?.seedKey).not.toBe(alberti?.seedKey);
  });

  it("a Buenos Aires partido is a municipio, from the department, whatever the reference says", () => {
    // 06021060 (Villa María, BA) has no entry in the reference: the partido
    // still governs it — in Buenos Aires the department IS the municipio.
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    for (const id of ["ba-mechita-alberti", "ba-villa-maria"]) {
      expect(unitOf(plan, id)).toMatchObject({
        seedKey: "municipio:AR-B:06021",
        kind: "municipio",
        level: "municipal",
        name: "Alberti",
        indecDepartmentCode: "06021",
        parentSeedKey: "provincia:AR-B",
      });
    }
  });

  it("Córdoba: one department holds several local governments, each its own unit", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    expect(unitOf(plan, "cba-villa-maria")).toMatchObject({
      seedKey: "gobierno_local:AR-X:140357",
      kind: "municipio",
      level: "municipal",
      name: "Villa María",
      indecDepartmentCode: null,
      parentSeedKey: "provincia:AR-X",
    });
    const villaNueva = unitOf(plan, "cba-villa-nueva");
    expect(villaNueva).toMatchObject({
      seedKey: "gobierno_local:AR-X:140364",
      name: "Villa Nueva",
    });
    // One government, two localities: Sanabria is governed by Villa Nueva.
    expect([...(villaNueva?.localityIds ?? [])].sort()).toEqual([
      "cba-sanabria",
      "cba-villa-nueva",
    ]);
    expect(plan.units.some((u) => u.kind === "departamento")).toBe(false);
  });

  it("a locality with no local government gets no municipal unit: the province covers it", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    expect(plan.units.some((u) => u.localityIds.includes("cba-las-mojarras"))).toBe(false);
    expect(plan.withoutLocalGovernment.map((r) => r.id)).toEqual(["cba-las-mojarras"]);
    // Not an error an admin must fix: it is not listed as unplaced.
    expect(plan.unplaced).toEqual([]);
    expect(plan.units.some((u) => u.seedKey === "provincia:AR-X")).toBe(true);
  });

  it("a disputed locality is not placed either, nor a manual row without an INDEC id", () => {
    const disputed = loc("cba-disputed", "AR-X", "Parque Norte", "14014", "Capital", "14021310");
    const manual = loc("cba-manual", "AR-X", "Villa María Norte", "14042", "General San Martín");
    const plan = planAuthorityUnits([...CATALOGUE, disputed, manual], {
      ...REFERENCE,
      disputed: { "14021310": "components-disagree" },
    });
    expect(plan.withoutLocalGovernment.map((r) => r.id).sort()).toEqual([
      "cba-disputed",
      "cba-las-mojarras",
      "cba-manual",
    ]);
  });

  it("Mendoza: where the department is the municipio, the government unit governs the department", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    const laPaz = unitOf(plan, "mza-la-paz");
    expect(laPaz).toMatchObject({
      seedKey: "gobierno_local:AR-M:500042",
      kind: "municipio",
      name: "La Paz",
      parentSeedKey: "provincia:AR-M",
    });
    expect(unitOf(plan, "mza-desaguadero")?.seedKey).toBe(laPaz?.seedKey);
  });

  it("the kind follows the source category: only a Municipio is a municipio", () => {
    const rn = loc("rn-mencue", "AR-R", "Mencué", "62091", "Veinticinco de Mayo", "62091040");
    const plan = planAuthorityUnits([...CATALOGUE, rn], {
      ...REFERENCE,
      governments: {
        ...REFERENCE.governments,
        "625063": ["AR-R", "Comisión de Fomento", "Mencué"],
      },
      localities: { ...REFERENCE.localities, "62091040": "625063" },
    });
    expect(unitOf(plan, "rn-mencue")).toMatchObject({
      seedKey: "gobierno_local:AR-R:625063",
      kind: "comuna",
      level: "municipal",
      name: "Mencué",
    });
  });

  it("a government of another province is never a unit", () => {
    const plan = planAuthorityUnits(CATALOGUE, {
      ...REFERENCE,
      localities: { ...REFERENCE.localities, "14042090": "500042" },
    });
    expect(plan.units.some((u) => u.localityIds.includes("cba-las-mojarras"))).toBe(false);
    expect(plan.withoutLocalGovernment.map((r) => r.id)).toContain("cba-las-mojarras");
  });

  it("a province with no local-government data falls back to departamento proposals", () => {
    const plan = planAuthorityUnits(CATALOGUE, EMPTY_LOCAL_GOVERNMENTS);
    expect(unitOf(plan, "cba-villa-maria")).toMatchObject({
      seedKey: "departamento:AR-X:14042",
      kind: "departamento",
      level: "municipal",
      name: "General San Martín",
      indecDepartmentCode: "14042",
      parentSeedKey: "provincia:AR-X",
    });
    expect(unitOf(plan, "cba-las-mojarras")?.seedKey).toBe("departamento:AR-X:14042");
    expect(plan.withoutLocalGovernment).toEqual([]);
  });

  it("one provincial unit per province present, with no explicit members", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    const provincial = plan.units.filter((u) => u.level === "provincial");
    expect(provincial.map((u) => u.seedKey).sort()).toEqual([
      "provincia:AR-B",
      "provincia:AR-C",
      "provincia:AR-M",
      "provincia:AR-X",
    ]);
    for (const u of provincial) {
      expect(u).toMatchObject({ kind: "provincia", parentSeedKey: null, localityIds: [] });
    }
    expect(provincial.find((u) => u.provinceCode === "AR-X")?.name).toBe("Córdoba");
  });

  it("a locality with no department where the unit comes from it is not placed: reported, never guessed", () => {
    const orphan = loc("ba-orphan", "AR-B", "Sin Partido", null, null);
    const plan = planAuthorityUnits([...CATALOGUE, orphan], REFERENCE);
    expect(plan.unplaced).toEqual([orphan]);
    expect(plan.units.some((u) => u.localityIds.includes("ba-orphan"))).toBe(false);
  });

  it("a row the catalogue guard drops (superseded source, whole-province aggregate) governs nothing", () => {
    const comuna = { ...loc("caba-comuna-2", "AR-C", "CABA - Comuna 2", "02014", "Comuna 2") };
    const city = loc("caba-city", "AR-C", "Ciudad Autónoma de Buenos Aires", null, null);
    const plan = planAuthorityUnits(
      [...CATALOGUE, { ...comuna, source: "indec_cppdyl" }, { ...city, source: "indec_cppdyl" }],
      REFERENCE,
    );
    expect(plan.excluded.map((r) => r.id).sort()).toEqual(["caba-city", "caba-comuna-2"]);
    expect(plan.units.some((u) => u.localityIds.includes("caba-comuna-2"))).toBe(false);
    expect(plan.units.some((u) => u.localityIds.includes("caba-city"))).toBe(false);
    expect(plan.unplaced).toEqual([]);
  });

  it("the seed never invents a region: regions have no INDEC source, an admin creates them", () => {
    const plan = planAuthorityUnits(CATALOGUE, REFERENCE);
    expect(plan.units.filter((u) => u.kind === "region" || u.level === "regional")).toEqual([]);
  });

  it("the plan is deterministic whatever order the catalogue arrives in", () => {
    const a = planAuthorityUnits(CATALOGUE, REFERENCE);
    const b = planAuthorityUnits([...CATALOGUE].reverse(), REFERENCE);
    expect(b).toEqual(a);
  });
});

describe("reportGrantCoverage (D2: partial grants are listed, never widened)", () => {
  // Unit "municipio:AR-B:06021" governs 9 localities; the operator holds 8.
  const NINE = Array.from({ length: 9 }, (_, i) => `alberti-${i + 1}`);
  const MEMBERSHIP = new Map<string, string>(NINE.map((id) => [id, "municipio:AR-B:06021"]));
  const UNIT_SIZE = new Map<string, number>([["municipio:AR-B:06021", 9]]);

  function grant(
    id: string,
    localityId: string | null,
    locality = "X",
    province = "Buenos Aires",
  ): GrantForReport {
    return {
      id,
      userId: "operator-1",
      province,
      locality,
      localityId,
    };
  }

  it("an operator holding 8 of a 9-locality unit is listed, with what is missing", () => {
    const grants = NINE.slice(0, 8).map((id, i) => grant(`g${i}`, id));
    const report = reportGrantCoverage(grants, MEMBERSHIP, UNIT_SIZE);
    expect(report.partial).toEqual([
      {
        userId: "operator-1",
        unitId: "municipio:AR-B:06021",
        held: 8,
        unitSize: 9,
        grantIds: ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"],
      },
    ]);
    expect(report.complete).toEqual([]);
  });

  it("an operator holding the whole unit is complete, not partial", () => {
    const grants = NINE.map((id, i) => grant(`g${i}`, id));
    const report = reportGrantCoverage(grants, MEMBERSHIP, UNIT_SIZE);
    expect(report.partial).toEqual([]);
    expect(report.complete).toEqual([
      { userId: "operator-1", unitId: "municipio:AR-B:06021", held: 9, unitSize: 9 },
    ]);
  });

  it("a whole-province grant is provincial, and a named grant with no id is unmapped, never guessed", () => {
    const report = reportGrantCoverage(
      [
        grant("whole", null, ""),
        grant("caba", null, "Ciudad Autónoma de Buenos Aires", "CABA"),
        grant("named", null, "Mechita"),
        grant("outside", "not-a-member"),
      ],
      MEMBERSHIP,
      UNIT_SIZE,
    );
    expect(report.wholeProvince.map((g) => g.id)).toEqual(["whole", "caba"]);
    expect(report.unmapped.map((g) => g.id)).toEqual(["named", "outside"]);
    expect(report.partial).toEqual([]);
  });
});
