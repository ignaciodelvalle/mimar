// The local-government reference generator's rules
// (scripts/generate-locality-gobierno-local.ts) and the committed file it
// produced (lib/reference/locality-gobierno-local.json). Pure — no database:
// the rules are proven on synthetic rows, the file on its content.

import { describe, expect, it } from "vitest";

import { INDEC_PROV_TO_ISO } from "@/lib/infra/geo-join";
import { LOCAL_GOVERNMENT_CATEGORIES } from "@/lib/place/authority-units-plan";
import { OFFICIAL_LOCAL_GOVERNMENTS as REF } from "@/lib/place/local-governments";

import {
  type BahraRow,
  type CensusRow,
  type GovernmentRow,
  buildGobiernoLocal,
  normaliseCategory,
  renderGobiernoLocalFile,
} from "../scripts/generate-locality-gobierno-local";

const census = (id: string, gobiernoLocalId = ""): CensusRow => ({
  id,
  provinciaId: id.slice(0, 2),
  gobiernoLocalId,
});
const bahra = (id: string, localidadCensalId: string, gobiernoLocalId = ""): BahraRow => ({
  id,
  localidadCensalId,
  gobiernoLocalId,
});
const gov = (id: string, categoria = "Municipio", nombre = `Gobierno ${id}`): GovernmentRow => ({
  id,
  provinciaId: id.slice(0, 2),
  categoria,
  nombre,
});

const GOVS = [gov("140357"), gov("140364"), gov("500042"), gov("625063", "Comisión de Fomento")];

describe("buildGobiernoLocal", () => {
  it("takes the government the census row names", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042130", "140357")],
      bahra: [],
      gobiernos: GOVS,
    });
    expect(b.localities).toEqual({ "14042130": "140357" });
    expect(b.governments["140357"]).toEqual(["AR-X", "Municipio", "Gobierno 140357"]);
  });

  it("completes a census row that names none from its own BAHRA row, or from components that all agree", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042170"), census("50042010")],
      bahra: [
        bahra("14042170", "14042170", "140357"),
        bahra("5004201001", "50042010", "500042"),
        bahra("5004201002", "50042010", "500042"),
      ],
      gobiernos: GOVS,
    });
    expect(b.localities).toEqual({ "14042170": "140357", "50042010": "500042" });
  });

  it("disputes a locality the sources disagree on, never picking one", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042120", "140357"), census("14042180")],
      bahra: [
        bahra("14042120", "14042120", "140364"),
        bahra("1404218001", "14042180", "140357"),
        bahra("1404218002", "14042180", "140364"),
      ],
      gobiernos: GOVS,
    });
    expect(b.localities).toEqual({});
    expect(b.disputed).toEqual({
      "14042120": "sources-disagree",
      "14042180": "components-disagree",
    });
  });

  it("disputes a locality only part of whose components name a government", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042180")],
      bahra: [bahra("1404218001", "14042180", "140364"), bahra("1404218002", "14042180", "")],
      gobiernos: GOVS,
    });
    expect(b.disputed).toEqual({ "14042180": "partially-covered" });
  });

  it("refuses a government of another province, or one the publisher does not list", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042090", "500042"), census("14042100", "149999")],
      bahra: [],
      gobiernos: GOVS,
    });
    expect(b.localities).toEqual({});
    expect(b.disputed).toEqual({
      "14042090": "government-outside-province",
      "14042100": "government-outside-province",
    });
  });

  it("leaves CABA out: the whole city is one ciudad unit, its comunas are submunicipal", () => {
    const b = buildGobiernoLocal({
      censales: [census("02014010")],
      bahra: [bahra("02014010", "02014010", "022014")],
      gobiernos: [gov("022014", "Comuna", "Comuna 2")],
    });
    expect(b).toEqual({ governments: {}, localities: {}, disputed: {} });
  });

  it("a locality nobody names a government for has no entry at all", () => {
    const b = buildGobiernoLocal({
      censales: [census("14042090")],
      bahra: [bahra("14042090", "14042090", "")],
      gobiernos: GOVS,
    });
    expect(b).toEqual({ governments: {}, localities: {}, disputed: {} });
  });

  it("keeps the category list closed: the publisher's typo is fixed, anything new throws", () => {
    expect(normaliseCategory("Comisiòn Municipal")).toBe("Comisión Municipal");
    expect(normaliseCategory("Comisión de Fomento")).toBe("Comisión de Fomento");
    expect(() => normaliseCategory("Delegación")).toThrow(/Unknown local government category/);
  });

  it("renders the same bytes whatever order the sources arrive in", () => {
    const input = {
      censales: [census("14042130", "140357"), census("50042010", "500042")],
      bahra: [],
      gobiernos: GOVS,
    };
    const reversed = { ...input, censales: [...input.censales].reverse() };
    expect(renderGobiernoLocalFile(buildGobiernoLocal(reversed))).toBe(
      renderGobiernoLocalFile(buildGobiernoLocal(input)),
    );
  });
});

describe("the committed lib/reference/locality-gobierno-local.json", () => {
  const localities = Object.entries(REF.localities);
  const provinceOf = (indecId: string) => INDEC_PROV_TO_ISO[indecId.slice(0, 2)];

  it("is populated", () => {
    expect(localities.length).toBeGreaterThan(3_000);
    expect(Object.keys(REF.governments).length).toBeGreaterThan(1_500);
  });

  it("points every locality at a listed government of its own province, with a known category", () => {
    for (const [indecId, gid] of localities) {
      const g = REF.governments[gid];
      expect(g, `${indecId} → ${gid}`).toBeDefined();
      expect(g?.[0], `${indecId} → ${gid}`).toBe(provinceOf(indecId));
      expect(LOCAL_GOVERNMENT_CATEGORIES).toContain(g?.[1]);
    }
  });

  it("never names a government for a locality it disputes, and nothing in CABA", () => {
    for (const id of Object.keys(REF.disputed)) expect(REF.localities[id]).toBeUndefined();
    expect(localities.filter(([id]) => provinceOf(id) === "AR-C")).toEqual([]);
  });

  // The seed keeps Buenos Aires = partido (the department). That is only right
  // while the official government of every Buenos Aires locality IS its
  // partido: the gobierno_local id is the INDEC department code with a "0"
  // after the province prefix (partido 06007 → gobierno local 060007).
  it("Buenos Aires: every locality's government is its partido", () => {
    const ba = localities.filter(([id]) => provinceOf(id) === "AR-B");
    expect(ba.length).toBeGreaterThan(500);
    const off = ba.filter(([id, gid]) => gid !== `${id.slice(0, 2)}0${id.slice(2, 5)}`);
    expect(off).toEqual([]);
  });

  // In La Rioja and San Juan the department IS the municipio (provincial
  // law): one government per department and one department per government.
  it("La Rioja and San Juan: department and government map one to one", () => {
    for (const province of ["AR-F", "AR-J"]) {
      const byDept = new Map<string, Set<string>>();
      const byGov = new Map<string, Set<string>>();
      for (const [id, gid] of localities.filter(([id]) => provinceOf(id) === province)) {
        const dept = id.slice(0, 5);
        byDept.set(dept, (byDept.get(dept) ?? new Set()).add(gid));
        byGov.set(gid, (byGov.get(gid) ?? new Set()).add(dept));
      }
      expect(byDept.size, province).toBeGreaterThan(10);
      expect(
        [...byDept.values()].every((s) => s.size === 1),
        province,
      ).toBe(true);
      expect(
        [...byGov.values()].every((s) => s.size === 1),
        province,
      ).toBe(true);
    }
  });
});
