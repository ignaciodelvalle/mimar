// D3 (PO decision, 2026-08-04) — "provincia entera fuera de CABA: SE CONSTRUYE
// AHORA". Any canonical province may now be assigned as a whole, via the empty
// locality sentinel; CABA keeps its INDEC whole-city entry unchanged.
//
// This is an AUTHORIZATION widening, so the tests below are written to prove
// three things in the same breath:
//   1. a whole-province assignment scopes to its province — and ONLY its
//      province (no other jurisdiction becomes visible);
//   2. a locality-scoped operator gains NOTHING from the change — no barrio,
//      no sibling locality, no province-wide reach;
//   3. the sentinel is not a hole: an unknown/non-canonical province never
//      becomes whole-province, and a null locality is never the sentinel.

import { describe, expect, it } from "vitest";

import {
  WHOLE_PROVINCE_LOCALITY,
  WHOLE_PROVINCE_SENTINEL,
  isWholeProvinceAssignment,
  isWholeProvinceLocality,
  jurisdictionScopeContains,
  narrowGovtScope,
} from "@/lib/domain/jurisdiction-canonical";
import { PROVINCES } from "@/lib/reference/ar-provincias";

const WHOLE_MENDOZA = { province: "Mendoza", locality: WHOLE_PROVINCE_SENTINEL };
const GODOY_CRUZ = { province: "Mendoza", locality: "Godoy Cruz" };
const WHOLE_CABA_INDEC = { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" };
const PALERMO = { province: "CABA", locality: "Palermo" };

describe("WHOLE_PROVINCE_LOCALITY — every province, CABA unchanged", () => {
  it("covers all 24 canonical provinces", () => {
    for (const p of PROVINCES) {
      expect(WHOLE_PROVINCE_LOCALITY, `missing ${p.name}`).toHaveProperty(p.name);
    }
    expect(Object.keys(WHOLE_PROVINCE_LOCALITY)).toHaveLength(PROVINCES.length);
  });

  it("keeps CABA's INDEC whole-city entry as its whole-province locality", () => {
    expect(WHOLE_PROVINCE_LOCALITY.CABA).toBe("Ciudad Autónoma de Buenos Aires");
    expect(isWholeProvinceLocality("CABA", "Ciudad Autónoma de Buenos Aires")).toBe(true);
  });

  it("gives every other province the generic sentinel", () => {
    expect(WHOLE_PROVINCE_LOCALITY.Mendoza).toBe(WHOLE_PROVINCE_SENTINEL);
    expect(WHOLE_PROVINCE_LOCALITY["Buenos Aires"]).toBe(WHOLE_PROVINCE_SENTINEL);
  });
});

describe("isWholeProvinceLocality — the widening, and its fences", () => {
  it("accepts the sentinel for any canonical province (D3)", () => {
    expect(isWholeProvinceLocality("Mendoza", WHOLE_PROVINCE_SENTINEL)).toBe(true);
    expect(isWholeProvinceLocality("Tierra del Fuego", WHOLE_PROVINCE_SENTINEL)).toBe(true);
    // CABA accepts BOTH forms — the INDEC name above and the sentinel here.
    expect(isWholeProvinceLocality("CABA", WHOLE_PROVINCE_SENTINEL)).toBe(true);
  });

  it("REJECTS a non-canonical province, sentinel or not (fail closed)", () => {
    expect(isWholeProvinceLocality("Gotham", WHOLE_PROVINCE_SENTINEL)).toBe(false);
    expect(isWholeProvinceLocality("mendoza", WHOLE_PROVINCE_SENTINEL)).toBe(false);
    expect(isWholeProvinceLocality("", WHOLE_PROVINCE_SENTINEL)).toBe(false);
  });

  it("REJECTS a null/undefined locality — only the empty STRING is the sentinel", () => {
    expect(isWholeProvinceLocality("Mendoza", null)).toBe(false);
    expect(isWholeProvinceLocality("Mendoza", undefined)).toBe(false);
  });

  it("never promotes a locality that merely shares the province's NAME", () => {
    // "Mendoza", "Córdoba", "Salta", "Santa Fe" are real localities inside the
    // provinces they name. If the sentinel were the province name, a
    // capital-city operator would silently become province-wide.
    expect(isWholeProvinceLocality("Mendoza", "Mendoza")).toBe(false);
    expect(isWholeProvinceLocality("Córdoba", "Córdoba")).toBe(false);
    expect(isWholeProvinceLocality("Santa Fe", "Santa Fe")).toBe(false);
  });

  it("keeps a locality-specific assignment exact-match", () => {
    expect(isWholeProvinceLocality("Mendoza", "Godoy Cruz")).toBe(false);
    expect(isWholeProvinceLocality("CABA", "Palermo")).toBe(false);
  });
});

describe("isWholeProvinceAssignment — wording and query now agree", () => {
  it("both forms are whole-province assignments", () => {
    expect(isWholeProvinceAssignment(WHOLE_MENDOZA)).toBe(true);
    expect(isWholeProvinceAssignment(WHOLE_CABA_INDEC)).toBe(true);
  });

  it("and both now scope the same way — the C3 disagreement is gone", () => {
    // Before D3 this pair disagreed: describeMandate said "Mendoza", while the
    // scope clause emitted `locality = ''` and matched nothing.
    expect(isWholeProvinceAssignment(WHOLE_MENDOZA)).toBe(
      isWholeProvinceLocality(WHOLE_MENDOZA.province, WHOLE_MENDOZA.locality),
    );
  });
});

describe("a WHOLE-PROVINCE assignment scopes to its province — and no further", () => {
  it("contains every locality of its own province", () => {
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], "Mendoza", "Godoy Cruz")).toBe(true);
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], "Mendoza", "San Rafael")).toBe(true);
    // Including localities that did not exist when the mandate was granted.
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], "Mendoza", "Localidad Nueva")).toBe(true);
  });

  it("contains NOTHING in another province", () => {
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], "CABA", "Palermo")).toBe(false);
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], "Buenos Aires", "La Plata")).toBe(false);
    expect(jurisdictionScopeContains([WHOLE_MENDOZA], null, null)).toBe(false);
  });

  it("narrows to a picked locality instead of emptying", () => {
    expect(narrowGovtScope([WHOLE_MENDOZA], "Mendoza", "Godoy Cruz")).toEqual([
      { province: "Mendoza", locality: "Godoy Cruz" },
    ]);
    // And refuses to narrow into a province it does not hold.
    expect(narrowGovtScope([WHOLE_MENDOZA], "CABA", "Palermo")).toEqual([]);
  });
});

describe("a LOCALITY-scoped operator gains nothing from D3", () => {
  it("still sees only its own locality", () => {
    expect(jurisdictionScopeContains([GODOY_CRUZ], "Mendoza", "Godoy Cruz")).toBe(true);
    expect(jurisdictionScopeContains([GODOY_CRUZ], "Mendoza", "San Rafael")).toBe(false);
    expect(jurisdictionScopeContains([GODOY_CRUZ], "Mendoza", WHOLE_PROVINCE_SENTINEL)).toBe(false);
  });

  it("does not become province-wide, and cannot narrow into a sibling", () => {
    expect(isWholeProvinceAssignment(GODOY_CRUZ)).toBe(false);
    expect(narrowGovtScope([GODOY_CRUZ], "Mendoza", "San Rafael")).toEqual([]);
    // A barrio operator is equally unmoved (the CABA case that already existed).
    expect(jurisdictionScopeContains([PALERMO], "CABA", "Almagro")).toBe(false);
  });
});
