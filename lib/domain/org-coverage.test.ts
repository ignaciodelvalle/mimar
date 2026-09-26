// The coverage predicate on the ID path (localidades-por-id D5).
//
// On the name path a coverage row "Buenos Aires / Mechita" covers both
// Mechitas. On the id path a row that recorded its catalogue row covers only
// that row; a row keyed to a unit covers the unit's localities (or its whole
// province for a provincial unit); a row that recorded nothing keeps the name
// rule. A zone the caller did not resolve (localityId absent) keeps the name
// rule whatever the mode.

import { describe, expect, it } from "vitest";

import { type CoverageArea, type PetZone, orgCoversZone } from "./org-coverage";

const ALBERTI = "loc-mechita-alberti";
const BRAGADO = "loc-mechita-bragado";

const mechitaBragadoRow: CoverageArea = {
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "Mechita",
  localityId: BRAGADO,
};
const zone = (localityId: string | null | undefined): PetZone => ({
  province: "Buenos Aires",
  locality: "Mechita",
  ...(localityId === undefined ? {} : { localityId }),
});

describe("orgCoversZone — id mode", () => {
  it("a row that recorded Bragado's Mechita does not cover Alberti's", () => {
    expect(orgCoversZone([mechitaBragadoRow], zone(ALBERTI), "id")).toBe(false);
    expect(orgCoversZone([mechitaBragadoRow], zone(BRAGADO), "id")).toBe(true);
    // The name path cannot tell them apart.
    expect(orgCoversZone([mechitaBragadoRow], zone(ALBERTI), "name")).toBe(true);
  });

  it("a row that recorded nothing keeps the name rule", () => {
    const byName: CoverageArea = {
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
    };
    expect(orgCoversZone([byName], zone(ALBERTI), "id")).toBe(true);
  });

  it("a province-wide row covers every zone of the province, resolved or not", () => {
    const wide: CoverageArea = { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null };
    expect(orgCoversZone([wide], zone(ALBERTI), "id")).toBe(true);
    expect(orgCoversZone([wide], zone(null), "id")).toBe(true);
  });

  it("a unit row covers its member localities, a provincial unit its province", () => {
    const unit: CoverageArea = {
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Alberti",
      authorityUnitId: "unit-alberti",
      unitLocalityIds: [ALBERTI],
    };
    expect(orgCoversZone([unit], zone(ALBERTI), "id")).toBe(true);
    expect(orgCoversZone([unit], zone(BRAGADO), "id")).toBe(false);
    // An unresolved zone never reaches a municipal unit (P1).
    expect(orgCoversZone([unit], zone(null), "id")).toBe(false);
    const provincial: CoverageArea = { ...unit, unitLocalityIds: "province" };
    expect(orgCoversZone([provincial], zone(null), "id")).toBe(true);
  });

  it("an unwired zone (no localityId) keeps the name rule in id mode", () => {
    expect(orgCoversZone([mechitaBragadoRow], zone(undefined), "id")).toBe(true);
  });
});
