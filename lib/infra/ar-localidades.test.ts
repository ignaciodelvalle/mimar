/**
 * Unit tests for isWholeProvinceAggregate — the province-as-locality overlap belt.
 *
 * Pure fixture tests (no DB): the fixture rows below are transcribed from the
 * live INDEC catalog (verified 2026-07-09 on DIM-staging). They pin the exact
 * distinction the belt must draw:
 *   - DROP  CABA's whole-city "componente" (indec_id 02000010) — it spans the
 *     province and double-counts the 48 barrios that tile it.
 *   - KEEP  every real capital city that merely SHARES its province's name
 *     (Córdoba, Mendoza, Salta, Paraná, San Luis, La Rioja…) — each sits in a
 *     departamento, so it is a real subdivision, not the province itself.
 *   - KEEP  every CABA barrio (Palermo, Recoleta…) — also department-less, but
 *     its name does not resolve to AR-C, so it is not the aggregate.
 *
 * If name-equality alone were the predicate it would wrongly drop the capitals;
 * if department-null alone were the predicate it would wrongly drop the barrios.
 * The invariant is the conjunction.
 */

import { describe, expect, it } from "vitest";

import { isWholeProvinceAggregate } from "@/lib/infra/ar-localidades";

// The single offender: CABA's whole-city aggregate.
const CABA_WHOLE_CITY = {
  provinceCode: "AR-C",
  localityName: "Ciudad Autónoma de Buenos Aires",
  departmentCode: null,
};

// Real capital cities whose name equals their province's name — all have a
// departamento and must be KEPT.
const CAPITALS_SHARING_PROVINCE_NAME = [
  { provinceCode: "AR-X", localityName: "Córdoba", departmentCode: "14014" },
  { provinceCode: "AR-M", localityName: "Mendoza", departmentCode: "50007" },
  { provinceCode: "AR-A", localityName: "Salta", departmentCode: "66028" },
  { provinceCode: "AR-E", localityName: "Paraná", departmentCode: "30084" },
  { provinceCode: "AR-D", localityName: "San Luis", departmentCode: "74056" },
  { provinceCode: "AR-F", localityName: "La Rioja", departmentCode: "46014" },
  { provinceCode: "AR-W", localityName: "Corrientes", departmentCode: "18021" },
];

// CABA barrios — department-less like the aggregate, but not the province.
const CABA_BARRIOS = [
  { provinceCode: "AR-C", localityName: "Palermo", departmentCode: null },
  { provinceCode: "AR-C", localityName: "Recoleta", departmentCode: null },
  { provinceCode: "AR-C", localityName: "La Boca", departmentCode: null },
];

describe("isWholeProvinceAggregate — drops the province-as-locality overlap", () => {
  it("flags CABA's whole-city 'componente' (indec 02000010) — via the alias", () => {
    expect(isWholeProvinceAggregate(CABA_WHOLE_CITY)).toBe(true);
  });

  it("flags the slug-normalized alias form of the whole city too", () => {
    // provinceByName tolerates the display name; the belt keys on the name field.
    expect(
      isWholeProvinceAggregate({
        provinceCode: "AR-C",
        localityName: "CABA",
        departmentCode: null,
      }),
    ).toBe(true);
  });
});

describe("isWholeProvinceAggregate — keeps real capitals sharing the province name", () => {
  for (const capital of CAPITALS_SHARING_PROVINCE_NAME) {
    it(`keeps ${capital.localityName} (${capital.provinceCode}) — it has a departamento`, () => {
      expect(isWholeProvinceAggregate(capital)).toBe(false);
    });
  }
});

describe("isWholeProvinceAggregate — keeps CABA barrios (department-less but not the province)", () => {
  for (const barrio of CABA_BARRIOS) {
    it(`keeps ${barrio.localityName}`, () => {
      expect(isWholeProvinceAggregate(barrio)).toBe(false);
    });
  }
});

describe("isWholeProvinceAggregate — invariant over the full fixture", () => {
  it("matches EXACTLY the CABA whole-city row and nothing else", () => {
    const all = [CABA_WHOLE_CITY, ...CAPITALS_SHARING_PROVINCE_NAME, ...CABA_BARRIOS];
    const aggregates = all.filter(isWholeProvinceAggregate);
    expect(aggregates).toEqual([CABA_WHOLE_CITY]);
  });

  it("does not flag a locality whose name does not resolve to its province", () => {
    expect(
      isWholeProvinceAggregate({
        provinceCode: "AR-B",
        localityName: "La Plata",
        departmentCode: null,
      }),
    ).toBe(false);
  });
});
