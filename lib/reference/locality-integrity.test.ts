// Unit tests for the two locality-catalog integrity predicates. Pure, no DB.
//
// WHY THE SECOND PREDICATE EXISTS (2026-08-21). isWholeProvinceAggregate was
// the whole rule, and it was written against ONE shape of the problem: INDEC
// shipping CABA as a single department-less city-wide row. On 2026-08-19 INDEC
// replaced that row with 15 per-Comuna rows — every one of them carrying a
// departamento_id, so the predicate's condition (2) never fires and all 15
// import as active indec_cppdyl rows for AR-C on every bootstrap.
//
// The rule the catalog actually holds is not about granularity: CABA IS its 48
// caba_open_data barrios (Ley 1.777), and NO indec_cppdyl row for AR-C belongs
// in the catalog at any granularity. isSupersededByAltSource states that rule
// directly, so the next time INDEC changes the shape the answer does not depend
// on the shape.

import { describe, expect, it } from "vitest";

import {
  ALT_SOURCE_PROVINCES,
  isSupersededByAltSource,
  isWholeProvinceAggregate,
} from "./locality-integrity";

describe("isWholeProvinceAggregate", () => {
  it("flags the department-less row whose name resolves to its own province", () => {
    expect(
      isWholeProvinceAggregate({
        provinceCode: "AR-C",
        localityName: "Ciudad Autónoma de Buenos Aires",
        departmentCode: null,
      }),
    ).toBe(true);
  });

  it("spares a capital city that shares its province name but sits in a departamento", () => {
    expect(
      isWholeProvinceAggregate({
        provinceCode: "AR-X",
        localityName: "Córdoba",
        departmentCode: "14014",
      }),
    ).toBe(false);
  });

  it("does NOT see the 15 CABA comunas — the gap that let them in", () => {
    // The live shape as of 2026-08-19, transcribed from
    // https://infra.datos.gob.ar/georef/localidades_censales.csv. Each carries a
    // departamento_id, so condition (2) is false and this predicate answers
    // "not an aggregate" — correctly, by its own definition. It is the wrong
    // question for this row, which is why the second predicate exists.
    expect(
      isWholeProvinceAggregate({
        provinceCode: "AR-C",
        localityName: "CABA - Comuna 2",
        departmentCode: "02014",
      }),
    ).toBe(false);
  });
});

describe("isSupersededByAltSource", () => {
  it("flags an INDEC row for a province an alternate source owns outright", () => {
    expect(isSupersededByAltSource({ provinceCode: "AR-C", source: "indec_cppdyl" })).toBe(true);
  });

  it("flags it at EVERY granularity — comuna, barrio, whole city", () => {
    // The point of stating the rule by source-and-province instead of by shape:
    // the 2026-08 upstream change swapped one shape for another and the answer
    // must not move. All three of these are the same violation.
    for (const name of ["Ciudad Autónoma de Buenos Aires", "CABA - Comuna 2", "Palermo"]) {
      expect(
        isSupersededByAltSource({ provinceCode: "AR-C", source: "indec_cppdyl" }),
        `${name} must be superseded regardless of its granularity`,
      ).toBe(true);
    }
  });

  it("keeps the alt source's OWN rows — they are the catalog for that province", () => {
    expect(isSupersededByAltSource({ provinceCode: "AR-C", source: "caba_open_data" })).toBe(false);
  });

  it("keeps curated manual rows: a supersede rule is not a licence to delete", () => {
    // The local catalog carries one — "Belgrano R", source 'manual', a real
    // neighbourhood the 48-barrio division does not name. Only the sources the
    // alt source explicitly supersedes are dropped.
    expect(isSupersededByAltSource({ provinceCode: "AR-C", source: "manual" })).toBe(false);
  });

  it("leaves every other province's INDEC rows alone", () => {
    expect(isSupersededByAltSource({ provinceCode: "AR-B", source: "indec_cppdyl" })).toBe(false);
    expect(isSupersededByAltSource({ provinceCode: "AR-X", source: "indec_cppdyl" })).toBe(false);
  });

  it("declares the row floor its province owes, so a shrunken catalog is visible", () => {
    // NON-VACUITY input for the CI gate: "no INDEC rows for AR-C" is trivially
    // true of an EMPTY AR-C catalog, which is a far worse state than the one
    // being guarded against. The gate cross-checks this floor.
    expect(ALT_SOURCE_PROVINCES["AR-C"].minimumRows).toBe(48);
    expect(ALT_SOURCE_PROVINCES["AR-C"].source).toBe("caba_open_data");
  });
});
