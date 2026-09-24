// Unit tests for the pure GeoJSON construction helpers.

import { describe, expect, it } from "vitest";

import {
  emptyFeatureCollection,
  featureCollection,
  pointFeature,
} from "@/src/modules/panorama/domain/geojson";

describe("pointFeature", () => {
  it("emits coordinates in GeoJSON [lng, lat] order (NOT [lat, lng])", () => {
    // Buenos Aires: lat -34.6037, lng -58.3816.
    const f = pointFeature(-34.6037, -58.3816, { id: "1" });
    expect(f.geometry).not.toBeNull();
    expect(f.geometry?.coordinates).toEqual([-58.3816, -34.6037]);
  });

  it("parses string coordinates (postgres numeric(10,7) → string)", () => {
    const f = pointFeature("-34.6037000", "-58.3816000", { id: "1" });
    expect(f.geometry?.coordinates).toEqual([-58.3816, -34.6037]);
  });

  it("returns null geometry when either coordinate is missing (location_pair invariant)", () => {
    expect(pointFeature(null, -58.38, {}).geometry).toBeNull();
    expect(pointFeature(-34.6, null, {}).geometry).toBeNull();
    expect(pointFeature(undefined, undefined, {}).geometry).toBeNull();
    expect(pointFeature("", "", {}).geometry).toBeNull();
  });

  it("returns null geometry for non-finite coordinates", () => {
    expect(pointFeature("not-a-number", "-58.38", {}).geometry).toBeNull();
    expect(pointFeature(Number.NaN, 1, {}).geometry).toBeNull();
  });

  it("carries properties through unchanged and tags the feature", () => {
    const f = pointFeature(-34.6, -58.4, { kind: "lost", token: "DIM-1" });
    expect(f.type).toBe("Feature");
    expect(f.properties).toEqual({ kind: "lost", token: "DIM-1" });
  });
});

describe("featureCollection / emptyFeatureCollection", () => {
  it("wraps features in a typed FeatureCollection", () => {
    const fc = featureCollection([pointFeature(-34.6, -58.4, { id: "a" })]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
  });

  it("emptyFeatureCollection has zero features", () => {
    expect(emptyFeatureCollection()).toEqual({ type: "FeatureCollection", features: [] });
  });
});
