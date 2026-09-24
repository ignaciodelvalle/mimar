// @vitest-environment jsdom
//
// RA-3 C6 — the legend must not name a mark the frame does not paint.
//
// `MapChoropleth`'s "Estados especiales" list rendered its hatched «Datos
// insuficientes (privacidad)» swatch UNCONDITIONALLY, on every caller, whether
// or not any datum was suppressed. That is the exact defect
// components/panorama/__tests__/legend-suppression-parity.test.tsx was written
// for after live pixel verification found LegendPill announcing «k<5 protegido»
// over a canvas with zero hatched marks — reappearing in the OTHER map
// component, which that test file does not cover.
//
// A legend that announces an unpainted mark teaches the operator that the key
// and the canvas are not describing the same thing, and the notice they learn
// to skip is the privacy one.
//
// This file pins the GATE and its predicate: the swatch renders iff
// `cellsPaintHatch(data)` — the shared atom in hatch-pattern.ts, beside
// `layerPaintsHatch` / `frameHasSuppressedMark`, not a second local rule.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cellsPaintHatch } from "@/components/panorama/hatch-pattern";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

let loadHandler: (() => void) | null = null;
const addedLayerIds: string[] = [];

class FakeMap {
  on(event: string, layerOrHandler: unknown) {
    if (event === "load" && typeof layerOrHandler === "function") {
      loadHandler = layerOrHandler as () => void;
    }
  }
  addSource() {}
  addLayer(layer: { id: string }) {
    addedLayerIds.push(layer.id);
  }
  addImage() {}
  hasImage() {
    return false;
  }
  setFilter() {}
  fitBounds() {}
  getCanvas() {
    return { style: {} as CSSStyleDeclaration };
  }
  remove() {}
}

class FakePopup {
  setLngLat() {
    return this;
  }
  setHTML() {
    return this;
  }
  addTo() {
    return this;
  }
  remove() {}
}

// maplibre-gl v6 is ESM-only and publishes NO default export: the component
// under test binds the module NAMESPACE, so this fake must expose its classes
// at the TOP level. Nesting them under `default` again would not fail loudly —
// the component's map constructor would just read `undefined`, which is the worse
// (Phrased WITHOUT the literal constructor form on purpose: scripts/check-
// maplibre-locale.ts scans raw source and would read it as a real map here.)
// failure: a mock that shapes the module wrongly instead of not at all.
vi.mock("maplibre-gl", () => ({
  // `setWorkerUrl` is part of the module's surface since the single-door
  // loader (lib/ui/maplibre-loader.ts) started pointing the worker at a URL
  // webpack actually emits. A mock that omits it makes every map test throw
  // "No 'setWorkerUrl' export is defined" — which is the mock being honest
  // about having drifted from the module, not a failure of the component.
  setWorkerUrl: vi.fn(),
  Map: FakeMap,
  Popup: FakePopup,
}));

import { type ChoroplethRegionDatum, MapChoropleth } from "./MapChoropleth";

function provinceFeature(code: string, name: string) {
  return {
    type: "Feature",
    properties: { code, name },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-58.5, -34.7],
          [-58.3, -34.7],
          [-58.3, -34.5],
          [-58.5, -34.5],
          [-58.5, -34.7],
        ],
      ],
    },
  };
}

const FAKE_GEOJSON = {
  type: "FeatureCollection",
  features: [provinceFeature("AR-C", "CABA"), provinceFeature("AR-V", "Tierra del Fuego")],
};

async function runLoad() {
  await waitFor(() => expect(loadHandler).not.toBeNull());
  loadHandler?.();
  await waitFor(() => expect(addedLayerIds.length).toBeGreaterThan(0));
}

const HATCH_ROW = /Datos insuficientes \(privacidad\)/;

beforeEach(() => {
  loadHandler = null;
  addedLayerIds.length = 0;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve(FAKE_GEOJSON) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MapChoropleth legend — the k-anon swatch is gated on the frame", () => {
  it("a frame with ZERO suppressed cells does NOT name the hatch", async () => {
    render(
      <MapChoropleth
        data={[
          { code: "AR-C", value: 30, label: "CABA" },
          { code: "AR-V", value: 8, label: "Tierra del Fuego" },
        ]}
        scaleLabel="Casos abiertos"
      />,
    );
    await runLoad();

    expect(screen.queryByText(HATCH_ROW)).not.toBeInTheDocument();
    // "Sin datos" is NOT gated: any province absent from `data` paints
    // COLOR_NO_DATA, so that swatch describes the basemap's default state.
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });

  it("an EMPTY frame does not name the hatch either", async () => {
    render(<MapChoropleth data={[]} scaleLabel="Casos abiertos" />);
    await runLoad();

    expect(screen.queryByText(HATCH_ROW)).not.toBeInTheDocument();
  });

  it("a frame that DOES paint a hatch names it, and says how many units are hidden", async () => {
    render(
      <MapChoropleth
        data={[
          { code: "AR-C", value: 30, label: "CABA" },
          { code: "AR-V", value: 0, suppressed: true, label: "Tierra del Fuego" },
        ]}
        scaleLabel="Casos abiertos"
      />,
    );
    await runLoad();

    expect(screen.getByText(HATCH_ROW)).toBeInTheDocument();
    // RA-3 C5 disclosure: the count comes from the frame's own marks, and the
    // es-AR phrasing agrees in number and gender ("1 jurisdicción oculta").
    expect(screen.getByText(/1 jurisdicción oculta/)).toBeInTheDocument();
  });

  it("an ALL-suppressed frame names the hatch once — the in-map card already states it", async () => {
    render(
      <MapChoropleth
        data={[
          { code: "AR-C", value: 0, suppressed: true, label: "CABA" },
          { code: "AR-V", value: 0, suppressed: true, label: "Tierra del Fuego" },
        ]}
        scaleLabel="Casos abiertos"
      />,
    );
    await runLoad();

    expect(screen.getByText(HATCH_ROW)).toBeInTheDocument();
    // The anchored corner card owns the total-suppression sentence; the legend
    // line would be the third copy of it in the same frame.
    expect(screen.queryByText(/jurisdicciones ocultas/)).not.toBeInTheDocument();
    expect(screen.getByText(/protegido por privacidad/)).toBeInTheDocument();
  });
});

describe("the gate reads the SHARED predicate, not a local rule", () => {
  // If someone re-inlines a `.some(d => d.suppressed)` in the component, this
  // stays green — so it is paired with the render tests above, which fail the
  // moment the two disagree. What it pins is that the atom exists and answers
  // for the cell-list carrier, the third one in hatch-pattern.ts's family.
  it("cellsPaintHatch answers for a ChoroplethRegionDatum-shaped frame", () => {
    expect(cellsPaintHatch([])).toBe(false);
    // A datum with no `suppressed` key at all — the common shape — answers false.
    expect(cellsPaintHatch([{ code: "AR-C", value: 3 } as ChoroplethRegionDatum])).toBe(false);
    expect(cellsPaintHatch([{ suppressed: false }, { suppressed: true }])).toBe(true);
  });
});
