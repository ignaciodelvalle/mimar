// #51 — the frozen ViewState the gob analytics screens embed for their map.
// Pins the poblacion → esterilizacion swap: national scope, single layer, the
// screen's default window, and the province-axis invariant that keeps the rate
// choropleth emitting ratePct (a scoped view would flip to locality count-density).

import { describe, expect, it } from "vitest";

import { gobEmbedView } from "@/src/modules/panorama/domain/embed-view";
import { scopeForcesLocality } from "@/src/modules/panorama/domain/view-state";

describe("gobEmbedView (gob analytics map embed)", () => {
  it("freezes a national, single-layer view for /gob/poblacion esterilizacion", () => {
    const view = gobEmbedView("esterilizacion", "trailing12m");
    expect(view.scope).toEqual({ kind: "national" });
    expect(view.layers).toEqual(["esterilizacion"]);
    expect(view.period).toEqual({ kind: "preset", preset: "trailing12m" });
  });

  it("keeps national scope so the choropleth aggregates on the PROVINCE axis", () => {
    // scopeForcesLocality === false is the invariant that makes the rate
    // choropleth emit province ratePct. A scoped view would flip the embed to the
    // locality count-density axis (a different metric) — see embed-view.ts.
    const view = gobEmbedView("esterilizacion", "trailing12m");
    expect(scopeForcesLocality(view)).toBe(false);
  });

  it("carries no chrome coupling (auto encoding, no preset, live edge)", () => {
    const view = gobEmbedView("esterilizacion", "trailing12m");
    expect(view.encoding).toBeNull();
    expect(view.preset).toBeNull();
    expect(view.asOf).toBeNull();
  });
});
