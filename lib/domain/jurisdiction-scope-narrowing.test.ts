// Regression tests for whole-province SUBSUMPTION in the Panorama scope
// intersection (critique of PR #762, findings 2 + 4).
//
// The bug: the console's govt scope intersection filtered assignments by EXACT
// (province, locality) equality. A WHOLE-PROVINCE assignment (the two-tier CABA
// model: assignment locality = "Ciudad Autónoma de Buenos Aires", which governs
// every barrio) therefore DISAPPEARED the moment a barrio locality filter was
// applied → scoped=[] → the loaders emitted `sql`false`` → a silently EMPTY
// map/KPIs, and the unit-history gate 403'd a cell the map had just rendered.
//
// narrowGovtScope + jurisdictionScopeContains apply subsumption so a
// whole-province assignment NARROWS to the picked locality instead of emptying.

import { describe, expect, it } from "vitest";

import { jurisdictionScopeContains, narrowGovtScope } from "@/lib/domain/jurisdiction-canonical";

const CABA_WHOLE = { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" };
const CABA_PALERMO = { province: "CABA", locality: "Palermo" };
const BA_LA_PLATA = { province: "Buenos Aires", locality: "La Plata" };
const BA_QUILMES = { province: "Buenos Aires", locality: "Quilmes" };

describe("narrowGovtScope — whole-province subsumption (finding 4)", () => {
  it("narrows a WHOLE-PROVINCE assignment to the selected barrio (was emptied before)", () => {
    // THE bug: whole-CABA operator picks Palermo. Old exact-match filter →
    // scoped=[] → empty map. Subsumption → the single Palermo unit.
    const scoped = narrowGovtScope([CABA_WHOLE], "CABA", "Palermo");
    expect(scoped).toEqual([{ province: "CABA", locality: "Palermo" }]);
  });

  it("keeps the whole-province assignment when only the province is selected", () => {
    const scoped = narrowGovtScope([CABA_WHOLE], "CABA", null);
    expect(scoped).toEqual([CABA_WHOLE]);
  });

  it("narrows a barrio-specific assignment to its own barrio", () => {
    const scoped = narrowGovtScope([CABA_PALERMO], "CABA", "Palermo");
    expect(scoped).toEqual([{ province: "CABA", locality: "Palermo" }]);
  });

  it("empties when a barrio operator picks a DIFFERENT barrio (never widens)", () => {
    const scoped = narrowGovtScope([CABA_PALERMO], "CABA", "Almagro");
    expect(scoped).toEqual([]);
  });

  it("narrows a multi-locality province assignment to the picked locality", () => {
    const scoped = narrowGovtScope([BA_LA_PLATA, BA_QUILMES], "Buenos Aires", "La Plata");
    expect(scoped).toEqual([{ province: "Buenos Aires", locality: "La Plata" }]);
  });

  it("empties when the picked locality is not owned in a normal province", () => {
    const scoped = narrowGovtScope([BA_LA_PLATA], "Buenos Aires", "Berazategui");
    expect(scoped).toEqual([]);
  });

  it("filters to province-scoped assignments when only the province is selected", () => {
    const scoped = narrowGovtScope([BA_LA_PLATA, BA_QUILMES, CABA_WHOLE], "Buenos Aires", null);
    expect(scoped).toEqual([BA_LA_PLATA, BA_QUILMES]);
  });

  it("returns the full assignment list (clone) when no province is selected", () => {
    const input = [BA_LA_PLATA, CABA_WHOLE];
    const scoped = narrowGovtScope(input, null, null);
    expect(scoped).toEqual(input);
    // Cloned — never a reference to the caller's array (defensive).
    expect(scoped).not.toBe(input);
  });

  it("empties when the operator has no assignment in the selected province", () => {
    expect(narrowGovtScope([BA_LA_PLATA], "CABA", "Palermo")).toEqual([]);
    expect(narrowGovtScope([BA_LA_PLATA], "CABA", null)).toEqual([]);
  });
});

describe("jurisdictionScopeContains — unit-history govt gate (finding 2)", () => {
  it("a WHOLE-PROVINCE operator contains any barrio in that province", () => {
    expect(jurisdictionScopeContains([CABA_WHOLE], "CABA", "Palermo")).toBe(true);
    expect(jurisdictionScopeContains([CABA_WHOLE], "CABA", "Almagro")).toBe(true);
  });

  it("a barrio-specific operator contains only its own barrio", () => {
    expect(jurisdictionScopeContains([CABA_PALERMO], "CABA", "Palermo")).toBe(true);
    expect(jurisdictionScopeContains([CABA_PALERMO], "CABA", "Almagro")).toBe(false);
  });

  it("never leaks across provinces", () => {
    expect(jurisdictionScopeContains([CABA_WHOLE], "Buenos Aires", "La Plata")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-province SAME-NAME homonym (C2, Tanda A).
//
// "never leaks across provinces" above uses two DIFFERENT locality names
// (Palermo vs La Plata), so a bug that compared locality alone (ignoring
// province) would still pass it — the names never collide. "Villa María" is a
// REAL cross-province homonym in the live ar_localities catalog (a Buenos
// Aires town, department Alberti, AND the INDEC agglomerate component for
// Villa María, Córdoba — see __tests__/ar-localidades.test.ts). These tests
// use the SAME locality name in both provinces, so they only pass when the
// comparison genuinely pairs province WITH locality.
// ---------------------------------------------------------------------------

const VILLA_MARIA_CBA = { province: "Córdoba", locality: "Villa María" };
const VILLA_MARIA_BA = { province: "Buenos Aires", locality: "Villa María" };

describe("jurisdictionScopeContains — Villa María cross-province homonym (C2)", () => {
  it("a govt scoped to Villa María, Córdoba does NOT contain the Buenos Aires homonym", () => {
    expect(jurisdictionScopeContains([VILLA_MARIA_CBA], "Buenos Aires", "Villa María")).toBe(false);
  });

  it("a govt scoped to Villa María, Buenos Aires does NOT contain the Córdoba homonym", () => {
    expect(jurisdictionScopeContains([VILLA_MARIA_BA], "Córdoba", "Villa María")).toBe(false);
  });

  it("each scope DOES contain its own (province, locality) pair", () => {
    expect(jurisdictionScopeContains([VILLA_MARIA_CBA], "Córdoba", "Villa María")).toBe(true);
    expect(jurisdictionScopeContains([VILLA_MARIA_BA], "Buenos Aires", "Villa María")).toBe(true);
  });
});

describe("narrowGovtScope — Villa María cross-province homonym (C2)", () => {
  it("a Córdoba-wide operator narrowed to 'Villa María' keeps only the Córdoba pair", () => {
    const scoped = narrowGovtScope(
      [{ province: "Córdoba", locality: "" }],
      "Córdoba",
      "Villa María",
    );
    expect(scoped).toEqual([VILLA_MARIA_CBA]);
  });

  it("a Buenos Aires operator scoped elsewhere is empty when Córdoba's Villa María is picked (never widens across provinces)", () => {
    const scoped = narrowGovtScope([VILLA_MARIA_BA], "Córdoba", "Villa María");
    expect(scoped).toEqual([]);
  });
});
