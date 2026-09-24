// Tests for the drill-level place-label anchors (task #64).

import { describe, expect, it } from "vitest";

import {
  type DivisionLabelAnchor,
  bboxCenter,
  divisionLabelAnchors,
  visibleDivisionLabels,
} from "@/components/panorama/division-labels";

describe("bboxCenter", () => {
  it("centers a simple polygon on its bounding box", () => {
    const center = bboxCenter({
      type: "Polygon",
      coordinates: [
        [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
          [-2, -2],
        ],
      ],
    });
    expect(center).toEqual([0, 0]);
  });

  it("spans all sub-polygons of a MultiPolygon", () => {
    const center = bboxCenter({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 0],
          ],
        ],
        [
          [
            [8, 8],
            [10, 8],
            [10, 10],
            [8, 8],
          ],
        ],
      ],
    });
    expect(center).toEqual([5, 5]);
  });

  it("returns null for an unsupported or empty geometry", () => {
    expect(bboxCenter(null)).toBeNull();
    expect(bboxCenter({ type: "Point", coordinates: [1, 2] })).toBeNull();
    expect(bboxCenter({ type: "Polygon", coordinates: [[]] })).toBeNull();
  });
});

describe("divisionLabelAnchors", () => {
  it("emits one anchor per feature with a code + name", () => {
    const anchors = divisionLabelAnchors([
      {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
              [-1, -1],
            ],
          ],
        },
        properties: { code: "02001", name: "Comuna 1" },
      },
    ]);
    // weight = bbox area = 2 (lng span) × 2 (lat span) = 4.
    expect(anchors).toEqual([{ code: "02001", name: "Comuna 1", lng: 0, lat: 0, weight: 4 }]);
  });

  it("skips features missing a code, name, or center", () => {
    const anchors = divisionLabelAnchors([
      { geometry: { type: "Polygon", coordinates: [[[0, 0]]] }, properties: { name: "Sin code" } },
      { geometry: { type: "Polygon", coordinates: [[[0, 0]]] }, properties: { code: "1" } },
      { geometry: null, properties: { code: "1", name: "Sin geom" } },
    ]);
    expect(anchors).toEqual([]);
  });
});

describe("visibleDivisionLabels", () => {
  // Three units of decreasing size (weight): big > mid > small.
  const anchors: DivisionLabelAnchor[] = [
    { code: "A", name: "Big", lng: 0, lat: 0, weight: 9 },
    { code: "B", name: "Mid", lng: 1, lat: 1, weight: 4 },
    { code: "C", name: "Small", lng: 2, lat: 2, weight: 1 },
  ];

  it("renders nothing below the minimum legibility zoom", () => {
    expect(visibleDivisionLabels(anchors, 6.5)).toEqual([]);
    expect(visibleDivisionLabels(anchors, 7.9)).toEqual([]);
  });

  it("renders every label at/above the all-labels zoom", () => {
    expect(visibleDivisionLabels(anchors, 9.6).map((a) => a.code)).toEqual(["A", "B", "C"]);
    expect(visibleDivisionLabels(anchors, 11).map((a) => a.code)).toEqual(["A", "B", "C"]);
  });

  it("reveals the largest units first inside the progressive band", () => {
    // Just past the min: only the biggest surfaces.
    const near = visibleDivisionLabels(anchors, 8.05);
    expect(near.map((a) => a.code)).toEqual(["A"]);
    // Higher in the band reveals more, still largest-first.
    const mid = visibleDivisionLabels(anchors, 8.8);
    expect(mid[0].code).toBe("A");
    expect(mid.length).toBeGreaterThanOrEqual(1);
    expect(mid.length).toBeLessThanOrEqual(3);
  });

  it("forceAll (opt-in) bypasses the zoom gate", () => {
    expect(visibleDivisionLabels(anchors, 3, { forceAll: true }).map((a) => a.code)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("caps the number of labels at maxLabels", () => {
    const many: DivisionLabelAnchor[] = Array.from({ length: 100 }, (_, i) => ({
      code: `c${i}`,
      name: `n${i}`,
      lng: i,
      lat: i,
      weight: i,
    }));
    expect(visibleDivisionLabels(many, 11, { maxLabels: 10 })).toHaveLength(10);
  });
});
