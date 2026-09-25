// The authority-unit seed plan (localidades-por-id C2, PO decisions D1 + D2).
//
// D1: units are seeded from INDEC departments — a Buenos Aires partido is a
// municipio, a department elsewhere is only a proposal (kind `departamento`,
// draft), CABA is ONE ciudad unit over every barrio. Every province gets one
// provincial unit with no explicit members.
// D2: a grant holding part of a unit is LISTED for confirmation, never widened.

import { describe, expect, it } from "vitest";

import {
  type CatalogueLocality,
  type GrantForReport,
  planAuthorityUnits,
  reportGrantCoverage,
} from "./authority-units-plan";

function loc(
  id: string,
  provinceCode: string,
  localityName: string,
  departmentCode: string | null,
  departmentName: string | null,
): CatalogueLocality {
  const source = provinceCode === "AR-C" ? "caba_open_data" : "indec_cppdyl";
  return { id, provinceCode, localityName, departmentCode, departmentName, source };
}

// Mechita exists in partido Alberti AND partido Bragado (Buenos Aires); Villa
// María exists in Buenos Aires (Alberti) and Córdoba (General San Martín).
const CATALOGUE: CatalogueLocality[] = [
  loc("ba-mechita-alberti", "AR-B", "Mechita", "06021", "Alberti"),
  loc("ba-villa-maria", "AR-B", "Villa María", "06021", "Alberti"),
  loc("ba-mechita-bragado", "AR-B", "Mechita", "06112", "Bragado"),
  loc("cba-villa-maria", "AR-X", "Villa María", "14042", "General San Martín"),
  loc("caba-palermo", "AR-C", "Palermo", null, null),
  loc("caba-recoleta", "AR-C", "Recoleta", null, null),
  loc("caba-belgrano-r", "AR-C", "Belgrano R", null, null),
];

function unitOf(plan: ReturnType<typeof planAuthorityUnits>, localityId: string) {
  const units = plan.units.filter((u) => u.localityIds.includes(localityId));
  expect(units, `${localityId} must sit in exactly one planned unit`).toHaveLength(1);
  return units[0];
}

describe("planAuthorityUnits", () => {
  it("CABA is one ciudad unit over every barrio, never a unit per barrio", () => {
    const plan = planAuthorityUnits(CATALOGUE);
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

  it("homonyms split by unit, within and across provinces", () => {
    const plan = planAuthorityUnits(CATALOGUE);
    const alberti = unitOf(plan, "ba-mechita-alberti");
    const bragado = unitOf(plan, "ba-mechita-bragado");
    expect(alberti?.seedKey).not.toBe(bragado?.seedKey);
    expect(unitOf(plan, "ba-villa-maria")?.seedKey).toBe(alberti?.seedKey);
    expect(unitOf(plan, "cba-villa-maria")?.seedKey).not.toBe(alberti?.seedKey);
  });

  it("a Buenos Aires partido is a municipio; a department elsewhere is a departamento proposal", () => {
    const plan = planAuthorityUnits(CATALOGUE);
    expect(unitOf(plan, "ba-mechita-alberti")).toMatchObject({
      seedKey: "municipio:AR-B:06021",
      kind: "municipio",
      level: "municipal",
      name: "Alberti",
      indecDepartmentCode: "06021",
      parentSeedKey: "provincia:AR-B",
    });
    expect(unitOf(plan, "cba-villa-maria")).toMatchObject({
      seedKey: "departamento:AR-X:14042",
      kind: "departamento",
      level: "municipal",
      name: "General San Martín",
      indecDepartmentCode: "14042",
      parentSeedKey: "provincia:AR-X",
    });
  });

  it("one provincial unit per province present, with no explicit members", () => {
    const plan = planAuthorityUnits(CATALOGUE);
    const provincial = plan.units.filter((u) => u.level === "provincial");
    expect(provincial.map((u) => u.seedKey).sort()).toEqual([
      "provincia:AR-B",
      "provincia:AR-C",
      "provincia:AR-X",
    ]);
    for (const u of provincial) {
      expect(u).toMatchObject({ kind: "provincia", parentSeedKey: null, localityIds: [] });
    }
    expect(provincial.find((u) => u.provinceCode === "AR-X")?.name).toBe("Córdoba");
  });

  it("a locality with no department outside CABA is not placed: it is reported, never guessed", () => {
    const orphan = loc("ba-orphan", "AR-B", "Sin Partido", null, null);
    const plan = planAuthorityUnits([...CATALOGUE, orphan]);
    expect(plan.unplaced).toEqual([orphan]);
    expect(plan.units.some((u) => u.localityIds.includes("ba-orphan"))).toBe(false);
  });

  it("a row the catalogue guard drops (superseded source, whole-province aggregate) governs nothing", () => {
    const comuna = { ...loc("caba-comuna-2", "AR-C", "CABA - Comuna 2", "02014", "Comuna 2") };
    const city = loc("caba-city", "AR-C", "Ciudad Autónoma de Buenos Aires", null, null);
    const plan = planAuthorityUnits([
      ...CATALOGUE,
      { ...comuna, source: "indec_cppdyl" },
      { ...city, source: "indec_cppdyl" },
    ]);
    expect(plan.excluded.map((r) => r.id).sort()).toEqual(["caba-city", "caba-comuna-2"]);
    expect(plan.units.some((u) => u.localityIds.includes("caba-comuna-2"))).toBe(false);
    expect(plan.units.some((u) => u.localityIds.includes("caba-city"))).toBe(false);
    expect(plan.unplaced).toEqual([]);
  });

  it("the seed never invents a region: regions have no INDEC source, an admin creates them", () => {
    const plan = planAuthorityUnits(CATALOGUE);
    expect(plan.units.filter((u) => u.kind === "region" || u.level === "regional")).toEqual([]);
  });

  it("the plan is deterministic whatever order the catalogue arrives in", () => {
    const a = planAuthorityUnits(CATALOGUE);
    const b = planAuthorityUnits([...CATALOGUE].reverse());
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
