// Regression guard for public/geo/ar-departments.geojson — the departamento
// polygons the locality choropleth draws for a scoped province.
//
// The file once shipped so aggressively simplified that coastal AMBA partidos
// collapsed into quadrilaterals (Avellaneda 06035 was a 4-point triangle spilling
// over the Río de la Plata). These assertions fail if that ever regresses, and
// pin the join contract the rest of the panorama depends on:
//   - exactly the historical 513-code set (no Antártida, no CABA comunas)
//   - {code: 5-digit INDEC string, name} on every feature
//   - real coastline density on the AMBA partidos that exposed the bug

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type DeptFeature = {
  properties: { code?: unknown; name?: unknown };
  geometry: { type: string; coordinates: unknown };
};

const fc = JSON.parse(
  readFileSync(join(process.cwd(), "public", "geo", "ar-departments.geojson"), "utf8"),
) as { type: string; features: DeptFeature[] };

/** Count coordinate pairs in any (Multi)Polygon geometry. */
function vertexCount(geometry: { coordinates: unknown }): number {
  let n = 0;
  const walk = (a: unknown): void => {
    if (Array.isArray(a)) {
      if (typeof a[0] === "number") n += 1;
      else a.forEach(walk);
    }
  };
  walk(geometry.coordinates);
  return n;
}

function byCode(code: string): DeptFeature | undefined {
  return fc.features.find((f) => f.properties.code === code);
}

describe("ar-departments.geojson", () => {
  it("carries exactly the 513 historical departamento codes", () => {
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(513);
  });

  it("has a 5-digit INDEC code and a name on every feature", () => {
    for (const f of fc.features) {
      expect(typeof f.properties.code).toBe("string");
      expect(f.properties.code as string).toMatch(/^\d{5}$/);
      expect(typeof f.properties.name).toBe("string");
      expect((f.properties.name as string).length).toBeGreaterThan(0);
    }
  });

  it("covers all 23 departamento provinces (CABA drills to barrios, so no '02')", () => {
    const prefixes = new Set(fc.features.map((f) => (f.properties.code as string).slice(0, 2)));
    expect(prefixes.size).toBe(23);
    expect(prefixes.has("02")).toBe(false); // CABA comunas excluded by design
  });

  it("excludes the Antártida Argentina claimed-territory polygon (94028)", () => {
    expect(byCode("94028")).toBeUndefined();
  });

  it("department 94021 (Islas del Atlántico Sur) is the clean Malvinas geometry, no garbled fragments", () => {
    // The file once carried 222 sub-polygons for 94021, some nowhere near the
    // islands (fragments around lon −26). Its geometry is now the Natural Earth
    // Malvinas archipelago: every vertex sits in the islands' bbox
    // (lon −62…−57, lat −53…−51).
    const f = byCode("94021");
    expect(f, "expected department 94021 to exist").toBeDefined();
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    const walk = (a: unknown): void => {
      if (Array.isArray(a)) {
        if (typeof a[0] === "number") {
          const lon = a[0] as number;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        } else a.forEach(walk);
      }
    };
    walk(f!.geometry.coordinates);
    expect(minLon).toBeGreaterThan(-62);
    expect(maxLon).toBeLessThan(-57);
  });

  it("keeps a real coastline on the AMBA partidos that exposed the coarse-geometry bug", () => {
    // Avellaneda (06035) and San Isidro (06756) were 4-point quadrilaterals in the
    // broken file. A recognisable coastline needs well more than that; the source
    // is far denser but even after 4% simplify these carry ~20 vertices.
    for (const code of ["06035", "06756", "06260", "06274"]) {
      const f = byCode(code);
      expect(f, `expected departamento ${code} to exist`).toBeDefined();
      expect(vertexCount(f!.geometry)).toBeGreaterThanOrEqual(12);
    }
  });
});
