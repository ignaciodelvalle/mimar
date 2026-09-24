// localitiesCoveringSearch — a barrio search must reach a whole-province row.
//
// Regression origin: the 2026-08-13 clickthrough of staging. A citizen searching
// "Recoleta, CABA" got "sin servicios" while the campaign meant for them was
// approved, public and materialising ~16 slots a day — stored as
// `CABA / Ciudad Autónoma de Buenos Aires`, i.e. WHOLE CABA. The search filtered
// locality with plain equality, so the barrio never reached the city row.
//
// These assert the SEARCH direction of subsumption (barrio search → whole-province
// row), which is the mirror of jurisdictionScopeContains (whole-province actor →
// barrio row). Both directions must hold or the same data is invisible from one
// side.

import { describe, expect, it } from "vitest";

import {
  WHOLE_PROVINCE_SENTINEL,
  localitiesCoveringSearch,
} from "@/lib/domain/jurisdiction-canonical";

describe("localitiesCoveringSearch", () => {
  it("reaches CABA's INDEC whole-city row from a barrio search — the bug that shipped", () => {
    const accepted = localitiesCoveringSearch("CABA", "Recoleta");
    expect(accepted).toContain("Ciudad Autónoma de Buenos Aires");
    expect(accepted).toContain("Recoleta");
  });

  it("still reaches the exact barrio row", () => {
    expect(localitiesCoveringSearch("CABA", "Palermo")).toContain("Palermo");
  });

  it("reaches the generic whole-province sentinel in a non-CABA province", () => {
    const accepted = localitiesCoveringSearch("Buenos Aires", "La Plata");
    expect(accepted).toContain("La Plata");
    expect(accepted).toContain(WHOLE_PROVINCE_SENTINEL);
  });

  it("does NOT widen to a sibling barrio — subsumption goes up, never sideways", () => {
    // The whole point: reaching the parent must not smear across the province.
    expect(localitiesCoveringSearch("CABA", "Recoleta")).not.toContain("Palermo");
  });

  it("fails closed on a non-canonical province: literal locality only", () => {
    // Mirrors isWholeProvinceLocality's refusal to widen an unknown province.
    expect(localitiesCoveringSearch("Capital Federal", "Recoleta")).toEqual(["Recoleta"]);
  });

  it("returns no duplicates when the search IS the whole-province string", () => {
    const accepted = localitiesCoveringSearch("CABA", "Ciudad Autónoma de Buenos Aires");
    expect(new Set(accepted).size).toBe(accepted.length);
  });
});
