import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetGeojsonCache, fetchGeojsonCached } from "@/components/panorama/geojson-cache";

describe("fetchGeojsonCached", () => {
  beforeEach(() => {
    __resetGeojsonCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    __resetGeojsonCache();
  });

  it("fetches a URL only once across repeat calls (session dedupe)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ features: [1, 2] }) });
    vi.stubGlobal("fetch", fetchMock);

    const a = await fetchGeojsonCached<{ features: number[] }>("/geo/x.geojson");
    const b = await fetchGeojsonCached<{ features: number[] }>("/geo/x.geojson");

    expect(a).toEqual({ features: [1, 2] });
    expect(b).toBe(a); // same resolved value object (one fetch, shared promise)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight requests to a single fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      fetchGeojsonCached("/geo/y.geojson"),
      fetchGeojsonCached("/geo/y.geojson"),
      fetchGeojsonCached("/geo/y.geojson"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection — a later call retries", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [7] }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGeojsonCached("/geo/z.geojson")).rejects.toThrow("network");
    const retry = await fetchGeojsonCached<{ features: number[] }>("/geo/z.geojson");

    expect(retry).toEqual({ features: [7] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws (and evicts) on a non-ok HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGeojsonCached("/geo/missing.geojson")).rejects.toThrow("404");
  });
});
