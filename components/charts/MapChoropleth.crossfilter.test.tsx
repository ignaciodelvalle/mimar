// @vitest-environment jsdom
//
// MapChoropleth — `paramKeys` cross-filter click path (router-drop cure,
// Group D). This prop has no current wired consumer (confirmed: all 6
// gob/* dashboard pages + design/dashboards + the 2 MapChoropleth/Dynamic
// wrappers omit it), but it's a documented extension point ("mismo patrón
// que PeriodPicker"), not accidental dead code — so the mechanism was cured
// (router.replace → window.location.assign) instead of deleted, matching
// PeriodPicker.tsx / JurisdictionSwitcher.tsx: every plausible host page is
// an async Server Component that fetches its KPIs from `searchParams`, so
// only a full document navigation actually re-runs that fetch. A sheet-nav
// shallow History-API primitive would update the URL but never re-filter
// the KPIs — see MapChoropleth.tsx's updateCrossFilter docblock.
//
// This test drives the real click→cross-filter path with a minimal
// maplibre-gl fake (no WebGL in jsdom) — asserting window.location.assign
// is called with the right param when a region is clicked, and never called
// when `paramKeys` is omitted (today's real-world state on every consumer).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("foo=bar"),
}));

// Minimal maplibre-gl fake: just enough surface for MapChoropleth's init
// effect to run to completion and register its "load" + layer-scoped
// "click" handlers, which this test then invokes directly to simulate a
// region click (no WebGL/canvas available in jsdom).
let loadHandler: (() => void) | null = null;
const layerClickHandlers: Record<string, (e: unknown) => void> = {};

class FakeMap {
  on(event: string, layerOrHandler: unknown, handler?: unknown) {
    if (event === "load" && typeof layerOrHandler === "function") {
      loadHandler = layerOrHandler as () => void;
    } else if (typeof layerOrHandler === "string" && typeof handler === "function") {
      if (event === "click") layerClickHandlers[layerOrHandler] = handler as (e: unknown) => void;
    }
  }
  addSource() {}
  addLayer() {}
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

async function triggerRegionClick() {
  await waitFor(() => expect(loadHandler).not.toBeNull());
  loadHandler?.();
  await waitFor(() => expect(layerClickHandlers["regions-fill"]).toBeDefined());
  layerClickHandlers["regions-fill"]({
    features: [{ properties: { code: "AR-C", name: "CABA" } }],
    lngLat: { lng: -58.4, lat: -34.6 },
  });
}

beforeEach(() => {
  loadHandler = null;
  for (const key of Object.keys(layerClickHandlers)) delete layerClickHandlers[key];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: () => Promise.resolve(FAKE_GEOJSON),
    }),
  );
  // window.location.assign isn't implemented by jsdom's navigation stub —
  // stub it directly so we can assert on it (mirrors PeriodPicker's own
  // test setup for the identical primitive).
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: vi.fn() },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<MapChoropleth> — paramKeys cross-filter (router-hot-path fix)", () => {
  it("clicking a region with paramKeys set calls window.location.assign with the region code, preserving other params", async () => {
    render(
      <MapChoropleth data={[{ code: "AR-C", value: 5 }]} paramKeys={{ province: "provincia" }} />,
    );

    await triggerRegionClick();

    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalledWith("?foo=bar&provincia=AR-C");
    });
  });

  it("clicking a region with no paramKeys (today's real-world state on every consumer) never calls window.location.assign", async () => {
    render(<MapChoropleth data={[{ code: "AR-C", value: 5 }]} />);

    await triggerRegionClick();

    // Give any stray async work a tick to settle before asserting a negative.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
