// @vitest-environment jsdom
//
// P5 gift (#51) — PanoramaEmbed renders the map surfaces from a FROZEN ViewState.
//
// Pins the embed contract: (1) one authz-fenced /api/panorama/[layer] fetch per
// frozen layer carrying the view's scope/period/verified — never the chrome
// params (layers/preset/encoding/camera); (2) the ActiveLayer assembly mirrors
// the console's marks (choropleth / graduated / reference) on the scope-derived
// axis (P4c rule); (3) the a11y label is the explainViewState sentence.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeViewState } from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";

let mapProps: Record<string, unknown> | null = null;
vi.mock("@/components/panorama/SituationalMapDynamic", () => ({
  SituationalMapDynamic: (props: Record<string, unknown>) => {
    mapProps = props;
    return <div data-testid="embed-map" />;
  },
}));

import { PanoramaEmbed } from "@/components/panorama/PanoramaEmbed";

const EMPTY = { type: "FeatureCollection", features: [] };
const fetchMock = vi.fn();

beforeEach(() => {
  mapProps = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ features: EMPTY }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PanoramaEmbed (P5 gift)", () => {
  it("fetches each frozen layer with the view's data params and NO chrome params", async () => {
    const view = makeViewState({
      scope: { kind: "province", province: "AR-C" },
      period: { kind: "preset", preset: "90d" },
      layers: ["cobertura", "zoonosis"],
      verifiedOnly: true,
      preset: "brotes-activos",
      encoding: "bivariate",
      camera: { zoom: 8, lat: -34.6, lng: -58.4 },
    });
    render(<PanoramaEmbed viewState={view} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/panorama/cobertura?"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/panorama/zoonosis?"))).toBe(true);
    for (const u of urls) {
      expect(u).toContain("province=AR-C");
      expect(u).toContain("period=90d");
      expect(u).toContain("verified=1");
      // Chrome params never reach the data route.
      expect(u).not.toContain("layers=");
      expect(u).not.toContain("preset=");
      expect(u).not.toContain("encoding=");
      expect(u).not.toContain("z=");
    }
  });

  it("assembles the console's marks on the scope-derived axis (P4c rule)", async () => {
    // National scope → province axis; a choropleth + an aggregated point +
    // a reference layer cover all three mark families.
    const view = makeViewState({ layers: ["cobertura", "perdidas", "refugios"] });
    render(<PanoramaEmbed viewState={view} />);

    await waitFor(() => {
      const layers = mapProps?.layers as Array<Record<string, unknown>>;
      expect(layers).toHaveLength(3);
    });
    const layers = mapProps?.layers as Array<Record<string, unknown>>;
    const byId = new Map(layers.map((l) => [l.id, l]));
    // choropleth: no renderMode (polygon fill path), province axis.
    expect(byId.get("cobertura")?.renderMode).toBeUndefined();
    expect(byId.get("cobertura")?.level).toBe("province");
    // aggregated point → graduated circles at the province axis.
    expect(byId.get("perdidas")?.renderMode).toBe("graduated");
    expect(byId.get("perdidas")?.level).toBe("province");
    // reference → pins, axis-less.
    expect(byId.get("refugios")?.renderMode).toBe("reference");
    expect(byId.get("refugios")?.level).toBeUndefined();
    // level=province flag reaches only the level-sensitive fetches.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.find((u) => u.includes("/cobertura"))).toContain("level=province");
    expect(urls.find((u) => u.includes("/refugios"))).not.toContain("level=province");
  });

  it("labels the map with the explainViewState sentence (a11y = honesty)", async () => {
    const view = makeViewState({ layers: ["denuncias"] });
    render(<PanoramaEmbed viewState={view} />);
    await waitFor(() => expect(mapProps).not.toBeNull());
    expect(mapProps?.label).toBe(explainViewState(view));
  });

  it("locks the camera (gob/map-zoom-lockdown follow-up, 2026-07-21): passes interactive={false}, unlike the console", async () => {
    // The embed is the ONLY caller that opts into the lockdown — see the
    // sibling assertion in PanoramaConsole.test.tsx proving the full
    // /gob/panorama console never sets this prop (stays interactive by
    // SituationalMap's own default).
    const view = makeViewState({ layers: ["denuncias"] });
    render(<PanoramaEmbed viewState={view} />);
    await waitFor(() => expect(mapProps).not.toBeNull());
    expect(mapProps?.interactive).toBe(false);
  });
});
