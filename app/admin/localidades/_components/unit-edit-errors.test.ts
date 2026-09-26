import { describe, expect, it } from "vitest";

import { unitEditErrorMessage } from "./unit-edit-errors";

describe("unitEditErrorMessage", () => {
  it("explains why a municipal membership cannot be removed", () => {
    expect(unitEditErrorMessage("MUNICIPAL_MEMBERSHIP_MOVES_ONLY")).toMatch(/sin municipio/);
  });

  // localidades-por-id D2: the partial-grant confirm flow's refusals.
  it("explains the grant-confirmation refusals in words", () => {
    expect(unitEditErrorMessage("PARTIAL_GRANT")).toMatch(/Marcá cada localidad/);
    expect(unitEditErrorMessage("WHOLE_PROVINCE_GRANT")).toMatch(/unidad provincial/);
    expect(unitEditErrorMessage("NO_GRANTS")).toMatch(/concesión/);
  });

  // localidades-por-id D9: the unresolved-place queue.
  it("says a queued place was already resolved", () => {
    expect(unitEditErrorMessage("NOT_UNRESOLVED")).toMatch(/ya se resolvió/);
  });

  it("asks to confirm a draft unit before moving grants onto it", () => {
    expect(unitEditErrorMessage("UNIT_NOT_CONFIRMED")).toBe(
      "Confirmá la unidad con la autoridad antes de pasarle concesiones.",
    );
  });

  it("shows a validation message as written, without its code", () => {
    expect(unitEditErrorMessage("VALIDATION_ERROR: Contá por qué cambia la unidad.")).toBe(
      "Contá por qué cambia la unidad.",
    );
  });

  it("never shows a raw code for an error it does not know", () => {
    expect(unitEditErrorMessage("SOMETHING_NEW")).toBe(
      "No se pudo guardar el cambio. Probá de nuevo.",
    );
  });
});
