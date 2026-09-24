// @vitest-environment jsdom
//
// Tests for lib/ui/use-layer-features.ts.
//
// buildLayerFeaturesUrl is pure (query-string construction). useLayerFeatures
// itself is exercised via @testing-library/react's renderHook against a
// stubbed global fetch — same AbortController-on-param-change idiom as
// components/panorama/DetailDrawer.tsx's UnitHistorySection, tested the same
// way MapChoropleth.crossfilter.test.tsx stubs globals for its own effect.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayerFeaturesUrl, useLayerFeatures } from "./use-layer-features";

describe("buildLayerFeaturesUrl", () => {
  it("builds the bare layer URL when no scope/period params are given", () => {
    expect(buildLayerFeaturesUrl({ layerId: "perdidas" })).toBe("/api/panorama/perdidas");
  });

  // NOTE: province/locality are opaque strings to this pure URL builder, but
  // in real usage they must be an ISO 3166-2:AR code (e.g. "AR-B") and a
  // locality slug — NOT display names — per app/api/panorama/[layer]/route.ts's
  // provinceByCode/localityByName resolution. Using realistic values here so
  // this test doesn't teach a future caller the wrong contract.
  it("includes province, locality, level and asOf when provided", () => {
    const url = buildLayerFeaturesUrl({
      layerId: "cobertura",
      province: "AR-B",
      locality: "la-plata",
      level: "province",
      asOf: "2026-06-01T00:00:00.000Z",
    });
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/panorama/cobertura");
    expect(parsed.searchParams.get("province")).toBe("AR-B");
    expect(parsed.searchParams.get("locality")).toBe("la-plata");
    expect(parsed.searchParams.get("level")).toBe("province");
    expect(parsed.searchParams.get("asOf")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("omits falsy/absent params entirely (no empty query string keys)", () => {
    const url = buildLayerFeaturesUrl({ layerId: "perdidas", province: null, locality: "" });
    expect(url).toBe("/api/panorama/perdidas");
  });
});

describe("useLayerFeatures", () => {
  const FAKE_RESPONSE = {
    features: { type: "FeatureCollection", features: [] },
    truncated: false,
    suppressedCount: 0,
    level: "locality",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(FAKE_RESPONSE),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts in loading state, then resolves to ok with the fetched data", async () => {
    const { result } = renderHook(() => useLayerFeatures({ layerId: "perdidas" }));

    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current).toStrictEqual({ status: "ok", data: FAKE_RESPONSE });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/panorama/perdidas",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("surfaces a Spanish error message when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    );

    const { result } = renderHook(() => useLayerFeatures({ layerId: "denuncias" }));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toStrictEqual({
      status: "error",
      message: "No se pudo cargar la capa.",
    });
  });

  it("refetches when a param changes, using the new param in the request URL", async () => {
    const { result, rerender } = renderHook(
      ({ province }: { province: string }) => useLayerFeatures({ layerId: "perdidas", province }),
      { initialProps: { province: "AR-B" } },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    rerender({ province: "AR-X" });

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const lastCallUrl = vi.mocked(fetch).mock.calls[1]?.[0] as string;
    expect(new URL(lastCallUrl, "http://x").searchParams.get("province")).toBe("AR-X");
  });
});
