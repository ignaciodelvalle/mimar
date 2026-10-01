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
  searchWidensToWholeCity,
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

// searchWidensToWholeCity — the SIDEWAYS step subsumption never takes (F-3).
//
// Native review 2026-09-23: a CABA barrio with nothing of its own answered "no
// hay turnos" while another barrio had a campaign, and the person had no way to
// know which barrio to try. The opt-in `ampliar=ciudad` re-runs that search city
// wide — and this predicate is the whole of WHERE it may.
describe("searchWidensToWholeCity", () => {
  it("lets a CABA barrio search widen to the city", () => {
    expect(searchWidensToWholeCity("CABA", "Palermo")).toBe(true);
    expect(searchWidensToWholeCity("CABA", "Villa Lugano")).toBe(true);
  });

  it("lets a legacy whole-city search widen too — to the barrio-tagged offerings it cannot reach", () => {
    // `localitiesCoveringSearch("CABA", "Ciudad Autónoma de Buenos Aires")` accepts
    // only the whole-city forms, so a pet still carrying the INDEC row would never
    // see a campaign tagged to one barrio without this.
    expect(searchWidensToWholeCity("CABA", "Ciudad Autónoma de Buenos Aires")).toBe(true);
  });

  it("never widens a province that is not one city — La Plata is not answered with Bahía Blanca", () => {
    expect(searchWidensToWholeCity("Buenos Aires", "La Plata")).toBe(false);
    expect(searchWidensToWholeCity("Córdoba", "Córdoba")).toBe(false);
    expect(searchWidensToWholeCity("Río Negro", "San Carlos de Bariloche")).toBe(false);
  });

  it("has nothing to widen when no locality was searched", () => {
    expect(searchWidensToWholeCity("CABA", null)).toBe(false);
    expect(searchWidensToWholeCity("CABA", "")).toBe(false);
    expect(searchWidensToWholeCity(null, "Palermo")).toBe(false);
  });

  it("fails closed on a non-canonical spelling of CABA", () => {
    // The search matches the province by equality, so an alias would widen a
    // search that never matched anything in the first place.
    expect(searchWidensToWholeCity("Capital Federal", "Palermo")).toBe(false);
    expect(searchWidensToWholeCity("Ciudad Autónoma de Buenos Aires", "Palermo")).toBe(false);
  });
});
