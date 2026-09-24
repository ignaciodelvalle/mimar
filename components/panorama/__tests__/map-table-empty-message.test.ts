// `mapTableEmptyMessage` — WHY the per-unit table is empty.
//
// This pure function is the table's half of the distinction the whole panorama
// turns on: "no hay nada" / "no pudimos mostrarlo acá" / "hay, pero está
// suprimido por k-anonimato" are three different facts, and for a municipality
// they imply opposite decisions. Collapsed into one blind "sin datos" they are
// indistinguishable, which is the failure mode this branch chain exists to
// prevent — and it had no tests at all until the RA-7 truth pass (2026-08-01).

import { describe, expect, it } from "vitest";

import { mapTableEmptyMessage } from "../MapDataTable";

describe("mapTableEmptyMessage — three causes, three sentences", () => {
  it("names the POINTS band first: the data exists, this zoom just does not tabulate it", () => {
    // Not an absence at all — the layer is drawn as individual records at this
    // zoom. The copy has to end the "no hay datos" reading explicitly.
    const msg = mapTableEmptyMessage({ pointModeLayers: ["Pérdidas"], suppressedUnits: 0 });
    expect(msg).toContain("Pérdidas");
    expect(msg).toContain("no es que no haya datos");
  });

  it("pluralizes the points-band verb when several layers are in that band", () => {
    const msg = mapTableEmptyMessage({
      pointModeLayers: ["Pérdidas", "Mordeduras"],
      suppressedUnits: 0,
    });
    expect(msg).toContain("Pérdidas y Mordeduras");
    expect(msg).toContain("se dibujan");
  });

  it("says PROTECTED, not absent, when units reported but were withheld", () => {
    // "Hay señal; no se puede publicar al detalle" is the whole point: a k-anon
    // empty is evidence of activity, and reading it as zero inverts the finding.
    const msg = mapTableEmptyMessage({ pointModeLayers: [], suppressedUnits: 3 });
    expect(msg).toContain("SÍ reportaron");
    expect(msg).toContain("k<5");
    expect(msg).not.toContain("Sin datos");
  });

  // RA-7 F6 — DECLARE THE UNIVERSE. This count is Σ over the layers that FEED
  // THIS TABLE, not the view-wide protected-cell total the legend pill shows.
  // The copy used to say "unidades del alcance", claiming the wider universe,
  // so a smaller number here read as a contradiction of the pill a few
  // centimetres away rather than as the narrower claim it is.
  it("attributes the protected count to THIS TABLE's layers, not to the whole scope", () => {
    const msg = mapTableEmptyMessage({ pointModeLayers: [], suppressedUnits: 3 });
    expect(msg).toContain("3 unidades de las capas de esta tabla");
    expect(msg).not.toContain("unidades del alcance");
  });

  it("falls back to a scoped absence only when neither cause applies", () => {
    expect(mapTableEmptyMessage({ pointModeLayers: [], suppressedUnits: 0 })).toBe(
      "Sin datos por unidad para las capas activas en este alcance.",
    );
  });

  it("prefers the points-band explanation over the k-anon one when both hold", () => {
    // Deliberate precedence: at this zoom the table is not the right surface at
    // all, so telling the operator to zoom out is more actionable than telling
    // them the rows they cannot see yet are protected.
    const msg = mapTableEmptyMessage({ pointModeLayers: ["Pérdidas"], suppressedUnits: 3 });
    expect(msg).toContain("no es que no haya datos");
    expect(msg).not.toContain("k<5");
  });
});
