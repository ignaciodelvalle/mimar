// The panorama masthead/footer scope label is an honesty surface: it is what
// tells an operator how much of the map is actually theirs. The map paints the
// whole province as context while the data stays scoped, so a label that
// overstates the scope is the difference between "context" and "a lie".

import { describe, expect, it } from "vitest";

import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { panoramaScopeLabel } from "@/lib/panorama/scope-label";

const j = (province: string, locality: string): AdminOrGovtJurisdiction => ({ province, locality });

describe("panoramaScopeLabel", () => {
  it("admin is national regardless of jurisdictions", () => {
    expect(panoramaScopeLabel("admin", [])).toBe("Nacional · todas las provincias");
    expect(panoramaScopeLabel("admin", [j("CABA", "Palermo")])).toBe(
      "Nacional · todas las provincias",
    );
  });

  it("a zero-jurisdiction account reads national", () => {
    expect(panoramaScopeLabel("govt", [])).toBe("Nacional · todas las provincias");
  });

  it("enumerates one or two localities", () => {
    expect(panoramaScopeLabel("govt", [j("CABA", "Palermo")])).toBe("CABA · Palermo");
    expect(panoramaScopeLabel("govt", [j("CABA", "Palermo"), j("CABA", "Recoleta")])).toBe(
      "CABA · Palermo, Recoleta",
    );
  });

  // QA ronda 5 (2026-07-16) regression. lucas@dim.test holds 5 CABA barrios.
  // The label used to collapse to bare "CABA" past the enumeration threshold,
  // which reads as the whole province — while the map painted ~48 comunas as
  // context and the Registros tab returned 5 rows. The operator had no way to
  // know the map was wider than their scope.
  it("states the COUNT past the enumeration threshold, never the bare province", () => {
    const fiveBarrios = [
      j("CABA", "Palermo"),
      j("CABA", "Recoleta"),
      j("CABA", "Retiro"),
      j("CABA", "Puerto Madero"),
      j("CABA", "San Nicolás"),
    ];
    expect(panoramaScopeLabel("govt", fiveBarrios)).toBe("CABA · 5 localidades");
    expect(panoramaScopeLabel("govt", fiveBarrios)).not.toBe("CABA");
  });

  it("counts distinct localities, not duplicate assignment rows", () => {
    const dupes = [
      j("CABA", "Palermo"),
      j("CABA", "Palermo"),
      j("CABA", "Recoleta"),
      j("CABA", "Retiro"),
    ];
    expect(panoramaScopeLabel("govt", dupes)).toBe("CABA · 3 localidades");
  });

  it("enumerates up to three provinces, then counts them", () => {
    expect(panoramaScopeLabel("govt", [j("CABA", "Palermo"), j("Córdoba", "Capital")])).toBe(
      "CABA, Córdoba",
    );
    expect(
      panoramaScopeLabel("govt", [
        j("CABA", "Palermo"),
        j("Córdoba", "Capital"),
        j("Santa Fe", "Rosario"),
        j("Mendoza", "Godoy Cruz"),
      ]),
    ).toBe("4 provincias");
  });
});
