// @vitest-environment jsdom
//
// StaticFirstMap — "static-first embed" pattern. Verifies:
//   1. renders a static, non-interactive placeholder by default (no maplibre
//      mount, no tile fetch) with the activation affordance.
//   2. clicking "Activar mapa interactivo" mounts the real MapLibre map with
//      cooperativeGestures/interactive true.
//   3. precision is always paired with TEXT, never color alone.
//
// maplibre-gl mocking mirrors components/charts/MapChoropleth.crossfilter.test.tsx's
// minimal FakeMap approach (no WebGL/canvas available in jsdom).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mapOptionsSeen: Record<string, unknown>[] = [];
const markerCalls: Array<{ options: Record<string, unknown>; lngLat: unknown }> = [];

const controlsAdded: Array<{ control: unknown; position: unknown }> = [];

class FakeMap {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    mapOptionsSeen.push(options);
  }
  remove() {}
  addControl(control: unknown, position: unknown) {
    controlsAdded.push({ control, position });
  }
}

// zoom-out fix (validacion-A 2026-07-23): the component now adds a
// NavigationControl so the fake maplibre-gl module needs one too.
class FakeNavigationControl {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

class FakeMarker {
  options: Record<string, unknown>;
  lngLat: unknown;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  setLngLat(lngLat: unknown) {
    this.lngLat = lngLat;
    markerCalls.push({ options: this.options, lngLat });
    return this;
  }
  addTo() {
    return this;
  }
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
  Marker: FakeMarker,
  NavigationControl: FakeNavigationControl,
}));

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

import { StaticFirstMap } from "./StaticFirstMap";

beforeEach(() => {
  mapOptionsSeen.length = 0;
  markerCalls.length = 0;
  controlsAdded.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("<StaticFirstMap> — static-first embed", () => {
  it("renders a static, non-interactive placeholder by default (no map mounted)", () => {
    render(<StaticFirstMap lat={-34.6} lng={-58.4} label="Plaza Italia" />);

    expect(screen.getByText("Activar mapa interactivo")).toBeInTheDocument();
    expect(screen.getByText("Plaza Italia")).toBeInTheDocument();
    // Precision paired with TEXT, not color alone.
    expect(screen.getByText("Ubicación exacta")).toBeInTheDocument();
    expect(mapOptionsSeen).toHaveLength(0);
  });

  it("keeps the activation button OUTSIDE the role='img' node", () => {
    // role="img" makes its entire subtree presentational. The role used to sit
    // on the container holding this button and its sr-only help text, so a
    // screen-reader user could not reach the only control that activates the
    // map. The existing tests all used getByText, which walks the DOM and not
    // the accessibility tree — they could never have seen it.
    const { container } = render(<StaticFirstMap lat={-34.6} lng={-58.4} label="Plaza Italia" />);

    const img = container.querySelector('[role="img"]');
    expect(img).not.toBeNull();
    const button = screen.getByText("Activar mapa interactivo");
    expect(img?.contains(button)).toBe(false);

    // The role must still be SOMEWHERE — deleting it outright would also pass
    // the assertion above while dropping the map's text alternative.
    expect(img).toHaveAttribute("aria-label", expect.stringContaining("Mapa estático"));
    // And the picture it names has to be inside it, or the label describes nothing.
    expect(img?.textContent).toContain("Plaza Italia");
  });

  it("shows 'Ubicación aproximada' as text (not a bare color swatch) when precision=approx", () => {
    render(<StaticFirstMap lat={-34.6} lng={-58.4} precision="approx" />);
    expect(screen.getByText("Ubicación aproximada")).toBeInTheDocument();
  });

  it("clicking the activation button mounts the real interactive MapLibre map", async () => {
    render(<StaticFirstMap lat={-34.6} lng={-58.4} zoom={16} label="Plaza Italia" />);

    fireEvent.click(screen.getByText("Activar mapa interactivo"));

    await waitFor(() => expect(mapOptionsSeen).toHaveLength(1));

    expect(mapOptionsSeen[0]).toMatchObject({
      center: [-58.4, -34.6],
      zoom: 16,
      interactive: true,
      cooperativeGestures: true,
    });

    await waitFor(() => expect(markerCalls).toHaveLength(1));
    expect(markerCalls[0]?.lngLat).toStrictEqual([-58.4, -34.6]);

    // The static placeholder button is gone; an interactive map container is
    // rendered in its place.
    expect(screen.queryByText("Activar mapa interactivo")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Mapa interactivo de Plaza Italia/)).toBeInTheDocument();
  });

  it("adds a NavigationControl so the viewer has an explicit zoom-out affordance (PO fix, validacion-A 2026-07-23)", async () => {
    render(<StaticFirstMap lat={-34.6} lng={-58.4} />);

    fireEvent.click(screen.getByText("Activar mapa interactivo"));

    await waitFor(() => expect(controlsAdded).toHaveLength(1));
    expect(controlsAdded[0]?.control).toBeInstanceOf(FakeNavigationControl);
    expect((controlsAdded[0]?.control as FakeNavigationControl).options).toMatchObject({
      showCompass: false,
    });
    expect(controlsAdded[0]?.position).toBe("top-right");
  });

  it("removes the map on unmount after activation", async () => {
    const removeSpy = vi.spyOn(FakeMap.prototype, "remove");
    const { unmount } = render(<StaticFirstMap lat={-34.6} lng={-58.4} />);

    fireEvent.click(screen.getByText("Activar mapa interactivo"));
    await waitFor(() => expect(mapOptionsSeen).toHaveLength(1));

    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
