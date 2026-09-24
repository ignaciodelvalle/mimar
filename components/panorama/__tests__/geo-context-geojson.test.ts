// Regression guard for the regional-context + Malvinas geo assets:
//   - public/geo/ar-provinces.geojson  — AR-V (Tierra del Fuego) MUST include
//     the Malvinas archipelago (Ley 26.651: Argentine maps show the Malvinas).
//   - public/geo/sudamerica-context.geojson — the muted neighbour-country
//     backdrop, which must NEVER contain a Malvinas/Falkland feature (the
//     islands render ONLY as Argentina).
//
// Regenerate both with `pnpm tsx scripts/prep-geo-context.ts`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type Feature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

function load(name: string): { type: string; features: Feature[] } {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "geo", name), "utf8"));
}

function lonRange(geometry: { coordinates: unknown }): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const walk = (a: unknown): void => {
    if (Array.isArray(a)) {
      if (typeof a[0] === "number") {
        const lon = a[0] as number;
        if (lon < min) min = lon;
        if (lon > max) max = lon;
      } else a.forEach(walk);
    }
  };
  walk(geometry.coordinates);
  return [min, max];
}

describe("ar-provinces.geojson — Malvinas merged into AR-V", () => {
  const fc = load("ar-provinces.geojson");
  const arv = fc.features.find((f) => f.properties.code === "AR-V");

  it("keeps the 24-province feature set", () => {
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(24);
  });

  it("AR-V exists with its {code,name} properties untouched", () => {
    expect(arv, "expected AR-V feature").toBeDefined();
    expect(arv!.properties.code).toBe("AR-V");
    expect(arv!.properties.name).toBe("Tierra del Fuego");
    expect(arv!.geometry.type).toBe("MultiPolygon");
  });

  it("AR-V extends east past lon −58 to include the Malvinas archipelago", () => {
    // Mainland Tierra del Fuego ends at lon ≈ −63.8; the Malvinas reach ≈ −57.8.
    const [, maxLon] = lonRange(arv!.geometry);
    expect(maxLon).toBeGreaterThan(-58);
  });
});

describe("sudamerica-context.geojson — neighbour backdrop", () => {
  const fc = load("sudamerica-context.geojson");

  it("carries exactly the six neighbour countries", () => {
    expect(fc.features).toHaveLength(6);
    const admins = new Set(fc.features.map((f) => f.properties.ADMIN));
    expect(admins).toEqual(new Set(["Chile", "Uruguay", "Brazil", "Paraguay", "Bolivia", "Peru"]));
  });

  it("never contains a Malvinas/Falkland feature (islands render only as Argentina)", () => {
    const hasIslands = fc.features.some((f) =>
      /falkland|malvina/i.test(String(f.properties.ADMIN)),
    );
    expect(hasIslands).toBe(false);
  });

  it("does not include Argentina (that geometry lives in ar-provinces)", () => {
    const hasArgentina = fc.features.some((f) => /argentin/i.test(String(f.properties.ADMIN)));
    expect(hasArgentina).toBe(false);
  });
});
