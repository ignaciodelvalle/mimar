// D1 METRIC-FIDELITY regression net for the SSR seed (build-panorama-board).
//
// The failure mode the D1 merge must never ship: a bare legacy `?preset=` link
// (no `&layers=`) resolving its ID to the merged preset but seeding the merged
// DEFAULT base — `?preset=control-poblacional` painting cobertura instead of
// esterilizacion. The alias table promises the id AND its layers; this test
// pins the promise at the exact seam that seeds SSR (`urlResolved.layerIds`).
//
// The DB-touching application modules are mocked at their seams (the loaders +
// the budget wrapper), so this exercises the REAL seeding decision logic with
// zero database.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/db-budget", () => ({
  // Budget wrapper: pass-through (budget/timeout behavior is its own suite).
  withDbBudget: vi.fn(async <T>(promise: Promise<T>) => promise),
}));

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

vi.mock("@/src/modules/panorama/application/get-layer-features", () => ({
  emptyLayerFeatures: () => ({
    features: EMPTY_FC,
    truncated: false,
    suppressedCount: 0,
    noLocalityCount: 0,
  }),
}));

const seedCalls: string[] = [];

vi.mock("@/src/modules/panorama/application/load-layer-features-cube", () => ({
  loadLayerFeaturesCubeOrCached: vi.fn(async () => ({
    features: EMPTY_FC,
    truncated: false,
    suppressedCount: 0,
    noLocalityCount: 0,
  })),
  loadLayerFeaturesCubeOrCachedWithMeta: vi.fn(async (layerId: string) => {
    seedCalls.push(layerId);
    return {
      result: { features: EMPTY_FC, truncated: false, suppressedCount: 0, noLocalityCount: 0 },
      source: "live" as const,
    };
  }),
}));

vi.mock("@/src/modules/panorama/application/load-panorama-kpis", () => ({
  loadCachedPanoramaKpis: vi.fn(async () => ({
    value: { kpis: [], recalculatedFor: "", dataAsOf: null },
  })),
}));

vi.mock("@/src/modules/panorama/application/get-panorama-kpis", () => ({
  degradedPanoramaKpis: () => ({
    kpis: [],
    recalculatedFor: "",
    dataAsOf: null,
    degraded: true,
  }),
}));

import { buildPanoramaBoard } from "@/lib/panorama/build-panorama-board";
import type { PanoramaRequestScope } from "@/src/modules/panorama/application/resolve-request-scope";

const SCOPE: PanoramaRequestScope = {
  provinceObj: null,
  localityRow: null,
  scoped: [],
  adminProvince: undefined,
  adminLocality: undefined,
};

async function seededBoardFor(sp: Record<string, string>) {
  seedCalls.length = 0;
  return buildPanoramaBoard({
    role: "admin",
    jurisdictions: [],
    sp,
    scope: SCOPE,
    seedLevel: "province",
    defaultPresetId: "bienestar",
    routeLabel: "admin/panorama",
  });
}

beforeEach(() => {
  seedCalls.length = 0;
});

describe("buildPanoramaBoard — D1 legacy `?preset=` seeds the LEGACY metric's layers", () => {
  // One case per aliased id: the id resolves to the surviving preset AND the
  // seeded layer set is the one the retired vista always painted.
  const CASES: Array<{ legacy: string; canonical: string; layers: string[] }> = [
    { legacy: "control-poblacional", canonical: "cumplimiento", layers: ["esterilizacion"] },
    { legacy: "registro-ppp", canonical: "cumplimiento", layers: ["ppp"] },
    { legacy: "microchip", canonical: "cumplimiento", layers: ["microchip"] },
    { legacy: "antiparasitario", canonical: "cumplimiento", layers: ["antiparasitario"] },
    { legacy: "riesgo-ppp", canonical: "cruce-mordeduras-ppp", layers: ["ppp", "mordeduras"] },
  ];

  for (const c of CASES) {
    it(`?preset=${c.legacy} (bare, no &layers=) seeds ${c.layers.join("+")} — never the merged default`, async () => {
      const board = await seededBoardFor({ preset: c.legacy });
      expect(board.seededPresetId).toBe(c.canonical);
      expect(board.seededLayers?.map((l) => l.id)).toEqual(c.layers);
      expect(seedCalls).toEqual(c.layers);
      // The regression proper: the compliance aliases must NOT fall back to the
      // merged preset's default cobertura base.
      if (c.legacy !== "riesgo-ppp") {
        expect(c.layers).not.toContain("cobertura");
        expect(seedCalls).not.toContain("cobertura");
      }
    });
  }

  it("a canonical `?preset=cumplimiento` still seeds its default base (cobertura)", async () => {
    const board = await seededBoardFor({ preset: "cumplimiento" });
    expect(board.seededPresetId).toBe("cumplimiento");
    expect(board.seededLayers?.map((l) => l.id)).toEqual(["cobertura"]);
  });

  it("an explicit `?layers=` override still wins over the preset seed (hand-built board)", async () => {
    const board = await seededBoardFor({ preset: "control-poblacional", layers: "mordeduras" });
    // Deep-link seeding is bypassed entirely — the non-first-visit path runs.
    expect(board.seededPresetId).toBeUndefined();
    expect(seedCalls).toEqual([]);
  });

  it("an unknown preset id falls through to the non-seeded path (no crash, no default hijack)", async () => {
    const board = await seededBoardFor({ preset: "not-a-preset" });
    expect(board.seededPresetId).toBeUndefined();
    expect(seedCalls).toEqual([]);
  });
});
