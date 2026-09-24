// @vitest-environment jsdom
//
// MapChoropleth — camera lockdown (gob/map-zoom-lockdown, 2026-07-21).
//
// PO decision: the operator CANNOT pan/zoom these maps by hand — the viewport
// is fully determined by the selected jurisdiction filter. Asserts, with a
// minimal maplibre-gl fake (no WebGL in jsdom):
//   1. every free-navigation interaction handler is initialized `false`
//      (dragPan/scrollZoom/boxZoom/doubleClickZoom/touchZoomRotate/
//      dragRotate/keyboard/touchPitch) — the map is display-only;
//   2. the auto-fit `fitBounds` call derives its bbox from the actually
//      rendered (visibleCodes-filtered) feature geometry, with a maxZoom
//      ceiling generous enough for a small/dense scope (CABA) — not the old
//      maxZoom:9 that capped every scope at the national-appropriate zoom;
//   3. a fresh mount with a different (smaller) feature bbox re-derives a
//      tighter fit — the mechanism the page-level `key={scope}` remount
//      (perdidas/censo/vigilancia) relies on to refit the LOCKED camera
//      whenever the jurisdiction filter changes scope.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

let loadHandler: (() => void) | null = null;
let lastMapOptions: Record<string, unknown> | null = null;
const fitBoundsCalls: Array<{ bbox: [[number, number], [number, number]]; opts: unknown }> = [];

class FakeMap {
  constructor(options: Record<string, unknown>) {
    lastMapOptions = options;
  }
  on(event: string, layerOrHandler: unknown) {
    if (event === "load" && typeof layerOrHandler === "function") {
      loadHandler = layerOrHandler as () => void;
    }
  }
  addSource() {}
  addLayer() {}
  addImage() {}
  hasImage() {
    return false;
  }
  setFilter() {}
  fitBounds(bbox: [[number, number], [number, number]], opts: unknown) {
    fitBoundsCalls.push({ bbox, opts });
  }
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

// A wide national-scale bbox (mirrors the real ar-provinces.geojson extent).
const NATIONAL_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { code: "AR-B", name: "Buenos Aires" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-63.4, -41.0],
            [-56.7, -41.0],
            [-56.7, -33.3],
            [-63.4, -33.3],
            [-63.4, -41.0],
          ],
        ],
      },
    },
  ],
};

// A small, dense CABA-scale bbox — the case the old maxZoom:9 cap broke.
const CABA_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { code: "AR-C", name: "CABA" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-58.53, -34.7],
            [-58.34, -34.7],
            [-58.34, -34.53],
            [-58.53, -34.53],
            [-58.53, -34.7],
          ],
        ],
      },
    },
  ],
};

async function runLoad() {
  await waitFor(() => expect(loadHandler).not.toBeNull());
  loadHandler?.();
  await waitFor(() => expect(fitBoundsCalls.length).toBeGreaterThan(0));
}

beforeEach(() => {
  loadHandler = null;
  lastMapOptions = null;
  fitBoundsCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<MapChoropleth> — camera lockdown", () => {
  it("initializes every free-navigation interaction handler to false (display-only map)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve(NATIONAL_GEOJSON) }),
    );
    render(<MapChoropleth data={[{ code: "AR-B", value: 5, label: "Buenos Aires" }]} />);
    await runLoad();

    expect(lastMapOptions).toMatchObject({
      dragPan: false,
      scrollZoom: false,
      boxZoom: false,
      doubleClickZoom: false,
      touchZoomRotate: false,
      dragRotate: false,
      keyboard: false,
      touchPitch: false,
    });
  });

  it("auto-fits to the rendered feature bbox with a maxZoom ceiling generous enough for a small/dense scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve(CABA_GEOJSON) }),
    );
    render(<MapChoropleth data={[{ code: "AR-C", value: 5, label: "CABA" }]} />);
    await runLoad();

    expect(fitBoundsCalls).toHaveLength(1);
    const { bbox, opts } = fitBoundsCalls[0];
    // Derived from CABA_GEOJSON's own coordinates, not hardcoded.
    expect(bbox[0][0]).toBeCloseTo(-58.53, 5);
    expect(bbox[0][1]).toBeCloseTo(-34.7, 5);
    expect(bbox[1][0]).toBeCloseTo(-58.34, 5);
    expect(bbox[1][1]).toBeCloseTo(-34.53, 5);
    // The old cap (maxZoom: 9) held CABA back from its natural ~z11 fit —
    // assert the ceiling is well above that, not the old value.
    expect((opts as { maxZoom: number }).maxZoom).toBeGreaterThan(9);
  });

  it("a fresh mount with a different (national-scale) bbox re-derives its own fit — the basis for the page-level key={scope} remount-on-filter-change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve(NATIONAL_GEOJSON) }),
    );
    const { unmount } = render(
      <MapChoropleth data={[{ code: "AR-B", value: 5, label: "Buenos Aires" }]} />,
    );
    await runLoad();
    expect(fitBoundsCalls).toHaveLength(1);
    const nationalBbox = fitBoundsCalls[0].bbox;
    unmount();

    // Simulate the page-level `key={scope}` change: a brand-new instance
    // (React would unmount + remount on a key change) with a narrower,
    // CABA-scale bbox — mirroring a jurisdiction filter change from
    // national to a single locality.
    loadHandler = null;
    fitBoundsCalls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve(CABA_GEOJSON) }),
    );
    render(<MapChoropleth data={[{ code: "AR-C", value: 5, label: "CABA" }]} />);
    await runLoad();

    expect(fitBoundsCalls).toHaveLength(1);
    const cabaBbox = fitBoundsCalls[0].bbox;
    expect(cabaBbox).not.toEqual(nationalBbox);
    // The CABA bbox is far smaller (tighter) than the national one.
    const span = (b: typeof cabaBbox) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
    expect(span(cabaBbox)).toBeLessThan(span(nationalBbox));
  });

  // NOTE (map-height-increase follow-up, 2026-07-21): a DOM-rendered assertion
  // of the default `height` (GOB_MAP_HEIGHT, a CSS clamp() string) was tried
  // here and dropped — jsdom's cssstyle package rejects `clamp()` as an
  // invalid value for `height` and silently no-ops the assignment (verified:
  // `el.style.height = "clamp(...)"` leaves `style.height === ""` and never
  // even sets the `style` attribute), even though real browsers have
  // supported `clamp()` in `height` since ~2020. The default wiring is
  // covered by source review instead: MapChoropleth.tsx's `height` default and
  // SituationalMap.tsx's `height` default both reference the SAME exported
  // `GOB_MAP_HEIGHT` constant (lib/ui/map-bounds.ts) as their single source of
  // truth, so there is nowhere for the two to drift apart.
});
