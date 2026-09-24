// Unit tests for buildAggregatedPointFeatures (pure, no DB).
//
// F1 Panorama v2: one graduated-symbol point per administrative unit for the
// density+signal layers (perdidas, mordeduras, denuncias, zoonosis). Reference
// layers (refugios, decomisos) are NOT aggregated; they keep the existing
// discrete-pin path (see build-features.test.ts for those).

import { describe, expect, it } from "vitest";

import { type AggregatedPointCell, buildAggregatedPointFeatures } from "../build-features";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cell(over: Partial<AggregatedPointCell> = {}): AggregatedPointCell {
  return {
    key: "Buenos Aires|La Plata",
    province: "Buenos Aires",
    locality: "La Plata",
    centroidLat: "-34.9200000",
    centroidLng: "-57.9500000",
    count: 17,
    suppressed: false,
    ...over,
  };
}

function provinceCell(over: Partial<AggregatedPointCell> = {}): AggregatedPointCell {
  return {
    key: "Córdoba",
    province: "Córdoba",
    locality: null,
    centroidLat: "-31.4200000",
    centroidLng: "-64.1800000",
    count: 42,
    suppressed: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAggregatedPointFeatures — locality level", () => {
  it("emits one Point feature per cell at the centroid [lng, lat]", () => {
    const fc = buildAggregatedPointFeatures([cell()]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    // GeoJSON coordinate order: [longitude, latitude] (RFC 7946 §3.1.1).
    expect(fc.features[0].geometry?.coordinates).toEqual([-57.95, -34.92]);
  });

  it("carries the correct properties for a visible locality cell", () => {
    const fc = buildAggregatedPointFeatures([cell({ count: 17, suppressed: false })]);
    const props = fc.features[0].properties;
    expect(props.count).toBe(17);
    expect(props.suppressed).toBe(false);
    expect(props.level).toBe("locality");
    expect(props.province).toBe("Buenos Aires");
    expect(props.locality).toBe("La Plata");
    // `place` is a human-readable label for the popup.
    expect(props.place).toBe("La Plata, Buenos Aires");
  });

  it("drops cells with no resolvable centroid (both coords null)", () => {
    const fc = buildAggregatedPointFeatures([cell({ centroidLat: null, centroidLng: null })]);
    expect(fc.features).toHaveLength(0);
  });

  it("drops cells where only lat is null", () => {
    const fc = buildAggregatedPointFeatures([cell({ centroidLat: null })]);
    expect(fc.features).toHaveLength(0);
  });

  it("drops cells where only lng is null", () => {
    const fc = buildAggregatedPointFeatures([cell({ centroidLng: null })]);
    expect(fc.features).toHaveLength(0);
  });

  it("renders suppressed cells with count=null (real count never leaks via k-anon)", () => {
    const fc = buildAggregatedPointFeatures([cell({ count: 3, suppressed: true })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.suppressed).toBe(true);
    // count MUST be null for suppressed cells — the real value must not leave the repository.
    expect(fc.features[0].properties.count).toBeNull();
  });

  it("returns an empty FeatureCollection for no input cells", () => {
    expect(buildAggregatedPointFeatures([])).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("handles multiple cells (mixed visible + suppressed)", () => {
    const fc = buildAggregatedPointFeatures([
      cell({
        key: "BA|LP",
        province: "Buenos Aires",
        locality: "La Plata",
        count: 17,
        suppressed: false,
      }),
      cell({
        key: "SA|CF",
        province: "Salta",
        locality: "Cafayate",
        centroidLat: "-26.0800000",
        centroidLng: "-65.9700000",
        count: 2,
        suppressed: true,
      }),
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties.count).toBe(17);
    expect(fc.features[1].properties.count).toBeNull();
    expect(fc.features[1].properties.suppressed).toBe(true);
  });
});

describe("buildAggregatedPointFeatures — province level", () => {
  it("emits one Point feature per province cell at the province centroid", () => {
    const fc = buildAggregatedPointFeatures([provinceCell()]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.coordinates).toEqual([-64.18, -31.42]);
  });

  it("carries level='province', no locality, place=province name", () => {
    const fc = buildAggregatedPointFeatures([provinceCell({ count: 42 })]);
    const props = fc.features[0].properties;
    expect(props.level).toBe("province");
    expect(props.locality).toBeNull();
    expect(props.province).toBe("Córdoba");
    expect(props.place).toBe("Córdoba");
    expect(props.count).toBe(42);
    expect(props.suppressed).toBe(false);
  });

  // ⚠️ REWRITTEN (A3, 2026-07-31). This read "province cells are never
  // suppressed (no k-anon at province level)" and fed the builder a cell with
  // `suppressed: false` — so it asserted the FIXTURE back and could not fail.
  // Worse, its title restated the premise task #40 retired as a leak (see the
  // `ProvinceChoroplethCell` doc comment in build-features.ts: "That was true of
  // a province's POPULATION and false of its DENOMINATOR"). The builder does not
  // and must not exempt a grain: `count: c.suppressed ? null : c.count` is level-
  // blind, and THAT is the contract worth pinning at province grain.
  it("a SUPPRESSED province cell publishes count=null — the grain grants no k-anon exemption", () => {
    const fc = buildAggregatedPointFeatures([provinceCell({ count: 1, suppressed: true })]);
    expect(fc.features[0].properties.level).toBe("province");
    expect(fc.features[0].properties.suppressed).toBe(true);
    // Never the raw count, and never a zero — a false zero reads as real data.
    expect(fc.features[0].properties.count).toBeNull();
    expect(fc.features[0].properties.count).not.toBe(1);
  });

  it("a VISIBLE province cell still carries its real count (no over-suppression)", () => {
    const fc = buildAggregatedPointFeatures([provinceCell({ count: 7, suppressed: false })]);
    expect(fc.features[0].properties.count).toBe(7);
    expect(fc.features[0].properties.suppressed).toBe(false);
  });

  it("drops province cells with no centroid", () => {
    const fc = buildAggregatedPointFeatures([
      provinceCell({ centroidLat: null, centroidLng: null }),
    ]);
    expect(fc.features).toHaveLength(0);
  });
});
