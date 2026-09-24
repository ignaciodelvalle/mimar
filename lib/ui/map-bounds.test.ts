// Unit tests for lib/ui/map-bounds.ts + map-bounds.server.ts.
//
// jurisdictionBounds is DB-bound (lib/infra/gov-scope.ts) — mocked here (same
// technique as any other jurisdictionBounds caller test) so boundsForScope's
// fallback logic is exercised without a live Postgres connection. AR_BBOX
// shape and fitBoundsOptions defaults are pure and need no mocking.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/gov-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/gov-scope")>();
  return {
    ...actual,
    jurisdictionBounds: vi.fn(),
  };
});

import { jurisdictionBounds } from "@/lib/infra/gov-scope";

import { AR_BBOX, type Bbox, GOB_MAP_HEIGHT, fitBoundsOptions } from "./map-bounds";
import { boundsForScope } from "./map-bounds.server";

describe("AR_BBOX", () => {
  it("is a valid MapLibre bbox ([[minLng,minLat],[maxLng,maxLat]]) with min < max on both axes", () => {
    const [[minLng, minLat], [maxLng, maxLat]] = AR_BBOX;
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
  });

  it("covers Argentina's widely-cited national extremes (SW ≈ -73.6,-55.1 · NE ≈ -53.6,-21.8)", () => {
    const [[minLng, minLat], [maxLng, maxLat]] = AR_BBOX;
    expect(minLng).toBeCloseTo(-73.6, 0);
    expect(minLat).toBeCloseTo(-55.1, 0);
    expect(maxLng).toBeCloseTo(-53.6, 0);
    expect(maxLat).toBeCloseTo(-21.8, 0);
  });
});

describe("fitBoundsOptions", () => {
  it("defaults to padding=24, maxZoom=9, animate=false — mirrors MapChoropleth.tsx's auto-fitBounds call", () => {
    expect(fitBoundsOptions()).toStrictEqual({ padding: 24, maxZoom: 9, animate: false });
  });

  it("defaults with no argument at all", () => {
    expect(fitBoundsOptions(undefined)).toStrictEqual({ padding: 24, maxZoom: 9, animate: false });
  });

  it("allows overriding a single field while keeping the rest on default", () => {
    expect(fitBoundsOptions({ maxZoom: 12 })).toStrictEqual({
      padding: 24,
      maxZoom: 12,
      animate: false,
    });
  });

  it("allows overriding every field", () => {
    expect(fitBoundsOptions({ padding: 40, maxZoom: 14, animate: true })).toStrictEqual({
      padding: 40,
      maxZoom: 14,
      animate: true,
    });
  });
});

describe("GOB_MAP_HEIGHT", () => {
  // Regression guard for the national-read refinement (2026-07-21): pins the
  // exact clamp() string so a future edit doesn't silently drift, and asserts
  // floor < mid-coefficient-implied-range < ceiling stay in a sane order.
  it("is the refined clamp(420px, 66vh, 800px)", () => {
    expect(GOB_MAP_HEIGHT).toBe("clamp(420px, 66vh, 800px)");
  });

  it("keeps the floor strictly below the ceiling (a valid clamp range)", () => {
    const match = GOB_MAP_HEIGHT.match(/^clamp\((\d+)px, (\d+)vh, (\d+)px\)$/);
    expect(match).not.toBeNull();
    const [, floor, , ceiling] = match as RegExpMatchArray;
    expect(Number(floor)).toBeLessThan(Number(ceiling));
  });
});

describe("boundsForScope", () => {
  it("returns the jurisdictionBounds result unchanged when it resolves a bbox", async () => {
    const bbox: Bbox = [
      [-58.5, -34.7],
      [-58.3, -34.5],
    ];
    vi.mocked(jurisdictionBounds).mockResolvedValueOnce(bbox);

    const result = await boundsForScope([{ province: "CABA", locality: "CABA" }]);

    expect(result).toStrictEqual(bbox);
  });

  it("falls back to AR_BBOX when jurisdictionBounds resolves null (admin universal scope)", async () => {
    vi.mocked(jurisdictionBounds).mockResolvedValueOnce(null);

    const result = await boundsForScope([]);

    expect(result).toStrictEqual(AR_BBOX);
  });

  it("falls back to AR_BBOX when jurisdictionBounds resolves null (no matching centroids)", async () => {
    vi.mocked(jurisdictionBounds).mockResolvedValueOnce(null);

    const result = await boundsForScope([{ province: "Buenos Aires", locality: "La Plata" }]);

    expect(result).toStrictEqual(AR_BBOX);
  });
});
