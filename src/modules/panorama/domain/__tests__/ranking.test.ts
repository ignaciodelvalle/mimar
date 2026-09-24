import { describe, expect, it } from "vitest";

import { rankUnitsInScope, rankWorstUnits } from "../ranking";
import type { FeatureCollection } from "../types";

// Helper: a value-carrying feature (province choropleth shape).
function rateFeature(
  provinceCode: string,
  label: string,
  value: number | null,
  suppressed = false,
) {
  return {
    type: "Feature" as const,
    geometry: null,
    properties: { provinceCode, label, value, suppressed },
  };
}

// Helper: an aggregated-point (density) feature.
function densityFeature(place: string, count: number | null, suppressed = false) {
  return {
    type: "Feature" as const,
    geometry:
      count == null
        ? null
        : { type: "Point" as const, coordinates: [-60, -35] as [number, number] },
    properties: { place, province: place, locality: null, level: "province", count, suppressed },
  };
}

function fc(features: Array<ReturnType<typeof rateFeature> | ReturnType<typeof densityFeature>>) {
  return { type: "FeatureCollection", features } as unknown as FeatureCollection;
}

describe("rankWorstUnits — rate layers (brecha vs meta)", () => {
  it("ranks units BELOW target by gap descending (worst gap first)", () => {
    const features = fc([
      rateFeature("AR-F", "Formosa", 31),
      rateFeature("AR-B", "Buenos Aires", 78),
      rateFeature("AR-H", "Chaco", 38),
      rateFeature("AR-X", "Córdoba", 90), // above meta — excluded
    ]);

    const rows = rankWorstUnits(features, { kind: "rate", target: 80, limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["Formosa", "Chaco", "Buenos Aires"]);
    expect(rows[0]).toMatchObject({ key: "AR-F", value: 31, gap: 49 });
  });

  it("excludes suppressed and non-numeric cells (privacy invariant — no value from a k-anon cell)", () => {
    const features = fc([
      rateFeature("AR-F", "Formosa", 31),
      rateFeature("AR-S", "Suprimida", null, true),
      rateFeature("AR-N", "SinDato", null),
    ]);

    const rows = rankWorstUnits(features, { kind: "rate", target: 80 });

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("AR-F");
  });

  it("returns an empty ranking when no unit is below meta", () => {
    const features = fc([
      rateFeature("AR-B", "Buenos Aires", 85),
      rateFeature("AR-X", "Córdoba", 92),
    ]);
    expect(rankWorstUnits(features, { kind: "rate", target: 80 })).toEqual([]);
  });

  it("caps the ranking at the requested limit (Worst-N = 10)", () => {
    const features = fc(Array.from({ length: 15 }, (_, i) => rateFeature(`AR-${i}`, `P${i}`, i)));
    expect(rankWorstUnits(features, { kind: "rate", target: 80, limit: 10 })).toHaveLength(10);
  });
});

// Regression (2026-07-10): the REAL province/locality choropleth features carry
// their display name in `province`/`locality`, NOT `label`/`place`/`name`. The
// helper above fabricated a `label` field production never emits, so the bug
// (identify() returning null → empty ranking → false "Sin jurisdicciones bajo
// meta") slipped past. These use the ACTUAL build-features prop shapes.
describe("rankWorstUnits — production choropleth prop shapes", () => {
  // Matches build-features.ts ProvinceChoroplethProps exactly.
  function provinceCell(provinceCode: string, province: string, value: number) {
    return {
      type: "Feature" as const,
      geometry: null,
      properties: { provinceCode, province, value, suppressed: false },
    };
  }
  // Matches build-features.ts ChoroplethProps (locality level) exactly.
  function localityCell(province: string, locality: string, value: number) {
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-60, -35] as [number, number] },
      properties: {
        province,
        locality,
        departmentCode: null,
        departmentName: null,
        value,
        suppressed: false,
      },
    };
  }

  it("ranks province-choropleth cells that key off `province`/`provinceCode` (real cobertura shape)", () => {
    const features = fc([
      provinceCell("AR-A", "Salta", 34),
      provinceCell("AR-X", "Córdoba", 65),
      provinceCell("AR-B", "Buenos Aires", 90), // above meta — excluded
    ] as never);

    const rows = rankWorstUnits(features, { kind: "rate", target: 80, limit: 10 });

    // Every real-world province (34–65%) is under the 80% meta → the ranking is
    // POPULATED, not the false "Sin jurisdicciones bajo meta" empty result.
    expect(rows.map((r) => r.label)).toEqual(["Salta", "Córdoba"]);
    expect(rows[0]).toMatchObject({ key: "AR-A", value: 34, gap: 46 });
  });

  it("labels locality-choropleth cells by `locality`, keyed for map sync", () => {
    const features = fc([localityCell("Salta", "Tartagal", 40)] as never);
    const rows = rankWorstUnits(features, { kind: "rate", target: 80 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "Tartagal", label: "Tartagal", value: 40, gap: 40 });
  });
});

describe("rankWorstUnits — density layers (count desc)", () => {
  it("ranks by count descending, gap null, dropping suppressed cells", () => {
    const features = fc([
      densityFeature("Rosario", 12),
      densityFeature("Suprimida", null, true),
      densityFeature("La Plata", 40),
    ]);

    const rows = rankWorstUnits(features, { kind: "density", limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["La Plata", "Rosario"]);
    expect(rows[0]).toMatchObject({ value: 40, gap: null });
  });
});

// POLARITY. "Worst" is a claim about meaning: for a harm count the worst unit is
// the biggest number, for an access or attainment measure it is the smallest.
// The default is unchanged (higher = worse), so no existing layer moved.
describe("rankWorstUnits — higher-is-better layers (polarity)", () => {
  it("ranks the LEAST-served unit first when a high value is good news", () => {
    // acceso-veterinario shape: visitas por 1.000 mascotas. Under the old
    // unconditional descending sort this list came back best-first, and the
    // panel's "Peores 10 · acceso veterinario" heading turned it into a lie.
    const features = fc([
      densityFeature("Formosa", 8),
      densityFeature("CABA", 310),
      densityFeature("Chaco", 22),
    ]);

    const rows = rankWorstUnits(features, { kind: "density", higherIsBetter: true, limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["Formosa", "Chaco", "CABA"]);
    expect(rows[0]).toMatchObject({ value: 8, gap: null });
  });

  it("an attainment target orders by the gap even on a density-kind layer", () => {
    // indice-territorial shape: a 0-100 score with a definitional meta of 100.
    // The console passes `target` for every layer it ranks, so declaring one is
    // what makes this layer read correctly with no caller change.
    const features = fc([
      rateFeature("AR-B", "Buenos Aires", 71),
      rateFeature("AR-F", "Formosa", 24),
      rateFeature("AR-C", "CABA", 100), // meta met — not a "worst" unit
    ]);

    const rows = rankWorstUnits(features, { kind: "density", target: 100, limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["Formosa", "Buenos Aires"]);
    expect(rows[0]).toMatchObject({ value: 24, gap: 76 });
  });

  it("leaves harm counts alone — the default is still highest-first", () => {
    const features = fc([densityFeature("Rosario", 12), densityFeature("La Plata", 40)]);

    expect(rankWorstUnits(features, { kind: "density" }).map((r) => r.label)).toEqual([
      "La Plata",
      "Rosario",
    ]);
  });
});

// P2.5 small-scope fallback: rank EVERY in-scope unit by the metric, including
// at/above-meta rate units that rankWorstUnits drops — so a jurisdiction with
// fewer than a full Worst-N still sees its units ordered, not "sin datos".
describe("rankUnitsInScope — small-scope fallback (P2.5)", () => {
  it("keeps at/above-meta rate units, worst coverage first, gap only below meta", () => {
    const features = fc([
      rateFeature("AR-C1", "Palermo", 92), // above meta — kept, gap null
      rateFeature("AR-C2", "Recoleta", 40), // below meta — gap 40
      rateFeature("AR-C3", "Retiro", 60), // below meta — gap 20
    ]);

    const rows = rankUnitsInScope(features, { kind: "rate", target: 80, limit: 10 });

    // Worst (lowest) coverage first; ALL units present (rankWorstUnits would drop Palermo).
    expect(rows.map((r) => r.label)).toEqual(["Recoleta", "Retiro", "Palermo"]);
    expect(rows[0]).toMatchObject({ value: 40, gap: 40 });
    // At/above meta carries no gap chip (no misleading "−(negative)").
    expect(rows[2]).toMatchObject({ label: "Palermo", value: 92, gap: null });
  });

  it("still drops suppressed / non-numeric cells (privacy invariant)", () => {
    const features = fc([
      rateFeature("AR-C1", "Palermo", 92),
      rateFeature("AR-C2", "Suprimida", null, true),
      rateFeature("AR-C3", "SinDato", null),
    ]);

    const rows = rankUnitsInScope(features, { kind: "rate", target: 80 });

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("AR-C1");
  });

  it("density fallback ranks all units by count descending (same as worst)", () => {
    const features = fc([densityFeature("Palermo", 5), densityFeature("Recoleta", 9)]);

    const rows = rankUnitsInScope(features, { kind: "density", limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["Recoleta", "Palermo"]);
    expect(rows[0]).toMatchObject({ value: 9, gap: null });
  });

  it("the small-scope fallback honours polarity too (least-served first)", () => {
    // The two orderings must agree: a scoped operator seeing "tus N comunas"
    // and a national operator seeing "Peores 10" cannot disagree about which
    // end of the same layer is the bad end.
    const features = fc([densityFeature("Palermo", 90), densityFeature("Recoleta", 12)]);

    const rows = rankUnitsInScope(features, { kind: "density", higherIsBetter: true, limit: 10 });

    expect(rows.map((r) => r.label)).toEqual(["Recoleta", "Palermo"]);
  });

  it("the small-scope fallback keeps at-meta units on a targeted density layer", () => {
    const features = fc([rateFeature("AR-C", "CABA", 100), rateFeature("AR-F", "Formosa", 24)]);

    const rows = rankUnitsInScope(features, { kind: "density", target: 100, limit: 10 });

    // Worst attainment first, and the at-meta unit stays listed without a gap.
    expect(rows.map((r) => r.label)).toEqual(["Formosa", "CABA"]);
    expect(rows[0]).toMatchObject({ value: 24, gap: 76 });
    expect(rows[1]).toMatchObject({ value: 100, gap: null });
  });
});
