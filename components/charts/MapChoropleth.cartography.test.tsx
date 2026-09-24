// @vitest-environment jsdom
//
// MapChoropleth — `cartography="panorama"` keeper-map polish (unify the two
// KEEPER maps — gob/vigilancia + gob/poblacion — with the Panorama
// SituationalMap cartographic FORM, WITHOUT migrating their
// ChoroplethRegionDatum data contract).
//
// Asserts, with a minimal maplibre-gl fake (no WebGL in jsdom):
//   1. panorama form adds the tonal stroke hierarchy (halo + admin strokes),
//      flat form keeps the single flat white outline;
//   2. panorama form builds the polished popup (className + structured card),
//      flat form keeps the v1 tooltip;
//   3. a SUPPRESSED cell never renders a number in the panorama popup (k-anon).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

// Capture layer ids, popup options, and the last tooltip HTML across renders.
let loadHandler: (() => void) | null = null;
const moveHandlers: Record<string, (e: unknown) => void> = {};
const addedLayerIds: string[] = [];
const addedLayerPaint: Record<string, unknown> = {};
const popupOptions: Array<Record<string, unknown>> = [];
let lastPopupHtml = "";

class FakeMap {
  on(event: string, layerOrHandler: unknown, handler?: unknown) {
    if (event === "load" && typeof layerOrHandler === "function") {
      loadHandler = layerOrHandler as () => void;
    } else if (typeof layerOrHandler === "string" && typeof handler === "function") {
      if (event === "mousemove") moveHandlers[layerOrHandler] = handler as (e: unknown) => void;
    }
  }
  addSource() {}
  addLayer(layer: { id: string; paint?: unknown }) {
    addedLayerIds.push(layer.id);
    addedLayerPaint[layer.id] = layer.paint;
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
  constructor(opts: Record<string, unknown>) {
    popupOptions.push(opts);
  }
  setLngLat() {
    return this;
  }
  setHTML(html: string) {
    lastPopupHtml = html;
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

import { MapChoropleth } from "./MapChoropleth";

const FAKE_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { code: "AR-C", name: "CABA" },
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
    },
  ],
};

async function runLoad() {
  await waitFor(() => expect(loadHandler).not.toBeNull());
  loadHandler?.();
  await waitFor(() => expect(addedLayerIds.length).toBeGreaterThan(0));
}

function fireHover(props: Record<string, unknown>) {
  const handler = moveHandlers["regions-fill"];
  expect(handler).toBeDefined();
  handler({ features: [{ properties: props }], lngLat: { lng: -58.4, lat: -34.6 } });
}

beforeEach(() => {
  loadHandler = null;
  for (const key of Object.keys(moveHandlers)) delete moveHandlers[key];
  addedLayerIds.length = 0;
  for (const key of Object.keys(addedLayerPaint)) delete addedLayerPaint[key];
  popupOptions.length = 0;
  lastPopupHtml = "";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve(FAKE_GEOJSON) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<MapChoropleth> — cartography='panorama' keeper-map polish", () => {
  it("adds the tonal stroke hierarchy (halo + admin) and a polished popup skin", async () => {
    render(
      <MapChoropleth data={[{ code: "AR-C", value: 5, label: "CABA" }]} cartography="panorama" />,
    );
    await runLoad();

    // Tonal stroke hierarchy: soft white halo UNDER a crisp mid-slate admin stroke.
    expect(addedLayerIds).toContain("regions-outline-halo");
    expect(addedLayerIds).toContain("regions-outline");
    expect(addedLayerIds.indexOf("regions-outline-halo")).toBeLessThan(
      addedLayerIds.indexOf("regions-outline"),
    );
    const admin = addedLayerPaint["regions-outline"] as Record<string, unknown>;
    expect(admin["line-color"]).toBe("#64748b");

    // Polished popup skin opted in via className.
    expect(popupOptions.some((o) => o.className === "mapchoropleth-popup")).toBe(true);
  });

  it("flat mode keeps the single white outline and no cartography popup skin", async () => {
    render(<MapChoropleth data={[{ code: "AR-C", value: 5, label: "CABA" }]} />);
    await runLoad();

    expect(addedLayerIds).not.toContain("regions-outline-halo");
    const outline = addedLayerPaint["regions-outline"] as Record<string, unknown>;
    expect(outline["line-color"]).toBe("#ffffff");
    expect(popupOptions.some((o) => o.className === "mapchoropleth-popup")).toBe(false);
  });

  it("panorama popup renders a suppressed cell as protected text, never a number (k-anon)", async () => {
    render(
      <MapChoropleth
        data={[{ code: "AR-C", value: 0, suppressed: true, label: "CABA" }]}
        scaleLabel="Casos abiertos"
        cartography="panorama"
      />,
    );
    await runLoad();

    fireHover({
      choropleth_label: "CABA",
      choropleth_suppressed: "yes",
      choropleth_value: 0,
    });

    expect(lastPopupHtml).toContain("Datos insuficientes");
    // The suppressed value is never emitted as a bare <strong>number</strong>.
    expect(lastPopupHtml).not.toMatch(/<strong>\s*0\s*<\/strong>/);
    // The scale-label caption is present (panorama structure).
    expect(lastPopupHtml).toContain("Casos abiertos");
  });
});
