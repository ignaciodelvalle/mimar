// @vitest-environment jsdom
//
// CabaInset — Round-3 QA fix 3: the CABA mini-map becomes a real drill target.
// Reuses the maplibre-gl mock pattern from components/maps/StaticFirstMap.test.tsx
// (no WebGL/canvas available in jsdom) since CabaInset mounts a real map on the
// synchronous render path via a dynamic `import("maplibre-gl")`.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  divisionFillColorExpr,
  divisionSuppressedFilter,
} from "@/components/panorama/division-fill";
import { fetchGeojsonCached } from "@/components/panorama/geojson-cache";

type PaintCall = { layerId: string; prop: string; value: unknown };
type FilterCall = { layerId: string; filter: unknown };

// Every FakeMap instance created during a test — the fill-sync tests read the
// LAST one (the instance the component under test actually mounted).
const createdMaps: FakeMap[] = [];

class FakeMap {
  paintCalls: PaintCall[] = [];
  filterCalls: FilterCall[] = [];

  constructor() {
    createdMaps.push(this);
  }

  on(event: string, cb: () => void | Promise<void>) {
    // The real maplibre-gl fires "load" once the style is ready; fire it
    // fire-and-forget (the handler is async, awaiting the mocked barrios
    // fetch) so syncFill runs and the test can `waitFor` its
    // setPaintProperty/setFilter calls.
    if (event === "load") void cb();
  }
  hasImage() {
    return false;
  }
  addImage() {}
  addSource() {}
  addLayer() {}
  addControl() {}
  // Truthy for every id — CabaInset gates syncFill on `map.getLayer(DATA_FILL)`
  // existing, which real maplibre satisfies once addLayer has run.
  getLayer(id: string) {
    return { id };
  }
  setPaintProperty(layerId: string, prop: string, value: unknown) {
    this.paintCalls.push({ layerId, prop, value });
  }
  setFilter(layerId: string, filter: unknown) {
    this.filterCalls.push({ layerId, filter });
  }
  // syncFill's first call is always syncBubble(map), which unconditionally
  // reads setLayoutProperty on the graduated bubble layer — missing this
  // silently threw inside the source's outer try/catch, making every fill
  // branch below it look like a no-op (this WAS the bug that made the first
  // draft of these tests fail: paintCalls stayed empty for the wrong reason).
  setLayoutProperty() {}
  fitBounds() {}
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
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

// The barrios GeoJSON fetch is irrelevant to the drill-button wiring under
// test and would otherwise hit a real network call in jsdom. The fill-sync
// tests below override this per-test (mockResolvedValueOnce) with real barrio
// features so `barrioCodesRef` is non-empty and the uniform-fill/suppressed
// branches (which require `codes.size > 0`) actually run.
vi.mock("@/components/panorama/geojson-cache", () => ({
  fetchGeojsonCached: vi.fn().mockResolvedValue({ features: [] }),
}));

import { CabaInset } from "./CabaInset";

afterEach(() => {
  cleanup();
  createdMaps.length = 0;
});

/** Two fake CABA barrios — enough to make `barrioCodesRef.current.size > 0`. */
const FAKE_BARRIOS = {
  features: [{ properties: { code: "caballito" } }, { properties: { code: "palermo" } }],
};

const DATA_FILL = "caba-inset-data";
const SUPPRESS_FILL = "caba-inset-suppress";

describe("<CabaInset> — Round-3 QA fix 3 (click-to-drill)", () => {
  it("stays a plain, non-interactive panel when no drill target is provided", () => {
    render(<CabaInset layer={null} visible />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("becomes a real <button> with an es-AR accessible label when onDrill is provided", () => {
    const onDrill = vi.fn();
    render(<CabaInset layer={null} visible onDrill={onDrill} />);

    const button = screen.getByRole("button", { name: "Ver CABA en detalle" });
    // A native <button> (not a div+role hack) — Enter/Space activation is free,
    // no bespoke onKeyDown wiring needed.
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });

  it("calls onDrill when clicked — the SAME drill seam a main-map province click uses", () => {
    const onDrill = vi.fn();
    render(<CabaInset layer={null} visible onDrill={onDrill} />);

    fireEvent.click(screen.getByRole("button", { name: "Ver CABA en detalle" }));
    expect(onDrill).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when not visible, regardless of onDrill", () => {
    const { container } = render(<CabaInset layer={null} visible={false} onDrill={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * syncFill — the flat CABA-level fill paths (bivariate risk cell OR province
 * value, both resolved by the parent into `uniformFill`/`uniformSuppressed`;
 * see SituationalMap.tsx's insetUniformFill/insetUniformSuppressed).
 *
 * These previously had ZERO coverage in this file (only the drill-button
 * wiring was tested) — the FakeMap above returns a truthy `getLayer()` (real
 * maplibre once `addLayer` has run) and fires "load" so `syncFill` actually
 * executes, and the barrios fetch is stubbed with two real features so
 * `barrioCodesRef.current.size > 0` (the guard every fill branch needs).
 */
describe("<CabaInset> — syncFill (bivariate/province flat fill + honesty)", () => {
  async function lastMap(): Promise<FakeMap> {
    await waitFor(() => expect(createdMaps.length).toBeGreaterThan(0));
    return createdMaps[createdMaps.length - 1];
  }

  it("paints the resolved uniform color (bivariate risk cell or province value) across all barrios", async () => {
    vi.mocked(fetchGeojsonCached).mockResolvedValueOnce(FAKE_BARRIOS);
    render(<CabaInset layer={null} visible uniformFill="#8f072e" scopeLabel="riesgo" />);

    const map = await lastMap();
    await waitFor(() =>
      expect(map.paintCalls).toContainEqual({
        layerId: DATA_FILL,
        prop: "fill-color",
        value: "#8f072e",
      }),
    );
    // No barrio is individually hatched — a uniform value is never suppressed.
    expect(map.filterCalls).toContainEqual({
      layerId: SUPPRESS_FILL,
      filter: divisionSuppressedFilter(new Set()),
    });
  });

  it("hatches EVERY barrio (never a color, never an empty panel) when the resolved value is k-anon suppressed", async () => {
    vi.mocked(fetchGeojsonCached).mockResolvedValueOnce(FAKE_BARRIOS);
    // uniformFill is null here — exactly what SituationalMap passes when a
    // bivariate cell's SIGNAL axis (e.g. a low-count mordeduras/zoonosis
    // province) is suppressed: bivariateCellColor withholds the color, but
    // the cell itself resolved (it is not absent), so the panel must read
    // "protegido", not "sin datos".
    render(
      <CabaInset layer={null} visible uniformFill={null} uniformSuppressed scopeLabel="riesgo" />,
    );

    const map = await lastMap();
    // The fill-color is the SAME no-data expression the honest-empty case uses
    // (never a fabricated color) — the DISTINGUISHING signal is the hatch filter.
    await waitFor(() =>
      expect(map.paintCalls).toContainEqual({
        layerId: DATA_FILL,
        prop: "fill-color",
        value: divisionFillColorExpr(new Map()),
      }),
    );
    // Every barrio is hatched (the full codes set, not the empty one) — reads
    // as PROTECTED, mirroring how a suppressed per-barrio cell already hatches
    // in the locality join, and how the main map hatches a suppressed province.
    expect(map.filterCalls).toContainEqual({
      layerId: SUPPRESS_FILL,
      filter: divisionSuppressedFilter(new Set(["caballito", "palermo"])),
    });
  });

  it("stays honest outline-only — no color, no hatch — when there is genuinely no CABA value at all", async () => {
    vi.mocked(fetchGeojsonCached).mockResolvedValueOnce(FAKE_BARRIOS);
    render(<CabaInset layer={null} visible uniformFill={null} uniformSuppressed={false} />);

    const map = await lastMap();
    await waitFor(() =>
      expect(map.paintCalls).toContainEqual({
        layerId: DATA_FILL,
        prop: "fill-color",
        value: divisionFillColorExpr(new Map()),
      }),
    );
    // Genuine absence never hatches — hatch means "protected", not "missing".
    expect(map.filterCalls).toContainEqual({
      layerId: SUPPRESS_FILL,
      filter: divisionSuppressedFilter(new Set()),
    });
  });
});
