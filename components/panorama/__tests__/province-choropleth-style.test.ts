// Unit tests for the U5 province-choropleth styling helpers (pure, no maplibre
// runtime, no DOM). These verify the data-driven fill-color expression colors
// the LOCAL polygons by joining on `code`, handles no-data + degenerate ranges,
// and that the legend bounds reflect the value range.

import { describe, expect, it } from "vitest";

import { PROVINCES } from "@/lib/reference/ar-provincias";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import { COLOR_NO_DATA, SCALE_BLUE_SEQ } from "@dim/contract/viz";

import { classSwatches } from "../class-scale";
import {
  hasSuppressedProvince,
  provinceCellAt,
  provinceColorExpr,
  provinceMetaClassScale,
  provinceMetaColorExpr,
  provinceNoDataFilter,
  provincePaintsNoData,
  provinceSeqClassScale,
  provinceSuppressedCodes,
  provinceValueBounds,
} from "../province-choropleth-style";

/** Decode a MapLibre `["step", input, c0, t1, c1, t2, …]` into breaks + colors. */
function decodeStep(step: unknown[]): { breaks: number[]; colors: string[] } {
  const colors: string[] = [step[2] as string];
  const breaks: number[] = [];
  for (let i = 3; i < step.length; i += 2) {
    breaks.push(step[i] as number);
    colors.push(step[i + 1] as string);
  }
  return { breaks, colors };
}

// Build a province FeatureCollection (null geometry; the polygon is the basemap).
function provinceFC(
  cells: Array<{ provinceCode: string; value: number | null; suppressed?: boolean }>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      geometry: null,
      properties: {
        provinceCode: c.provinceCode,
        province: c.provinceCode,
        value: c.value,
        suppressed: c.suppressed === true,
      },
    })),
  };
}

describe("provinceColorExpr", () => {
  it("builds a case→match→step (classed) expression keyed on the polygon `code`", () => {
    const expr = provinceColorExpr(
      provinceFC([
        { provinceCode: "AR-B", value: 61 },
        { provinceCode: "AR-X", value: 9 },
        { provinceCode: "AR-S", value: 22 },
        { provinceCode: "AR-C", value: 40 },
        { provinceCode: "AR-M", value: 77 },
      ]),
    ) as unknown as unknown[];

    // Top-level `case` with the no-data fallback path.
    expect(expr[0]).toBe("case");
    // The value lookup joins on the LOCAL polygon `code` property — NOT an
    // external provider, NOT the centroid. This is what colors the basemap.
    const valueMatch = (expr[1] as unknown[])[1] as unknown[];
    expect(valueMatch[0]).toBe("match");
    expect(valueMatch[1]).toEqual(["get", "code"]);
    // The match carries each province code → value pair.
    expect(valueMatch).toContain("AR-B");
    expect(valueMatch).toContain(61);
    expect(valueMatch).toContain("AR-X");
    expect(valueMatch).toContain(9);
    // The classed path is a MapLibre `step` over the dark-map ramp colors.
    const step = expr[3] as unknown[];
    expect(step[0]).toBe("step");
    // The base color (below the first break) is the ramp's low anchor; the
    // top class is the ramp's high anchor.
    expect(step[2]).toBe(SCALE_BLUE_SEQ[0]);
    expect(step).toContain(SCALE_BLUE_SEQ[SCALE_BLUE_SEQ.length - 1]);
  });

  it("paints everything neutral when there is no data", () => {
    expect(provinceColorExpr(provinceFC([]))).toBe(COLOR_NO_DATA);
  });

  it("collapses a degenerate single-value range to a flat class fill", () => {
    const expr = provinceColorExpr(
      provinceFC([{ provinceCode: "AR-V", value: 4 }]),
    ) as unknown as unknown[];
    // A single value has no ascending break → the classed path is a flat color
    // string (MapLibre `step` needs ≥ 1 threshold), not a step array.
    expect(typeof expr[3]).toBe("string");
    expect(SCALE_BLUE_SEQ).toContain(expr[3]);
  });
});

describe("provinceSeqClassScale — the lifted province legend scale (map/legend parity)", () => {
  const fc = provinceFC([
    { provinceCode: "AR-B", value: 10 },
    { provinceCode: "AR-X", value: 20 },
    { provinceCode: "AR-S", value: 30 },
    { provinceCode: "AR-C", value: 40 },
    { provinceCode: "AR-M", value: 50 },
  ]);

  it("returns null when there are no numeric values (fill paints all neutral)", () => {
    expect(provinceSeqClassScale(provinceFC([]))).toBeNull();
  });

  it("returns EXACTLY the breaks/colors the map fill's step expression renders (no divergence)", () => {
    const scale = provinceSeqClassScale(fc);
    expect(scale).not.toBeNull();
    const expr = provinceColorExpr(fc) as unknown as unknown[];
    const painted = decodeStep(expr[3] as unknown[]);
    // The off-canvas legend is built from `scale`; the map paints `painted`.
    // They MUST be identical — same values, same (absent) domain.
    expect(scale?.breaks).toEqual(painted.breaks);
    expect(scale?.colors).toEqual(painted.colors);
  });

  it("under scrub-frozen breaks the legend scale tracks the LOCKED fill, not the live edge", () => {
    // A scrub freezes the live-edge QUANTILE breaks (e.g. captured on an earlier
    // frame whose distribution differed) and reuses them verbatim.
    const frozen = [12, 24, 48, 96];
    const legendScale = provinceSeqClassScale(fc, frozen);
    const paintedLocked = decodeStep(
      (provinceColorExpr(fc, frozen) as unknown as unknown[])[3] as unknown[],
    );
    // Parity holds WITH the lock: the legend swatch ranges equal the painted
    // class breaks for the SAME frozen frame.
    expect(legendScale?.breaks).toEqual(paintedLocked.breaks);
    // The frozen breaks are painted verbatim (quantile, NOT equal-interval).
    expect(legendScale?.breaks).toEqual([12, 24, 48, 96]);
    // And the frozen scale genuinely DIFFERS from the live-edge scale — so a legend
    // that recomputed live-edge would mis-describe the scrubbed map.
    const liveScale = provinceSeqClassScale(fc);
    expect(liveScale?.breaks).not.toEqual(legendScale?.breaks);
  });

  // POLARITY (2026-07-26). The sequential ramp darkens with value, which is the
  // alarm reading for a harm magnitude and the exact inverse for the two layers
  // where a HIGH value is the good news (acceso-veterinario, indice-territorial).
  // `computeClassScale({ invert })` has always been able to reverse it; this call
  // site simply never passed the layer's declared polarity through.
  describe("higher-is-better polarity", () => {
    it("reverses the ramp so the darkest class lands on the LOWEST value", () => {
      const normal = provinceSeqClassScale(fc, null);
      const inverted = provinceSeqClassScale(fc, null, { invert: true });
      expect(inverted).not.toBeNull();
      // Same classing — only the colour assignment flips.
      expect(inverted?.breaks).toEqual(normal?.breaks);
      expect(inverted?.colors).toEqual([...(normal?.colors ?? [])].reverse());
    });

    it("leaves the ramp untouched by default (every harm layer is unaffected)", () => {
      expect(provinceSeqClassScale(fc, null, { invert: false })?.colors).toEqual(
        provinceSeqClassScale(fc, null)?.colors,
      );
    });

    it("paints the inverted ramp on the map fill, not only in the legend", () => {
      // Map/legend parity must survive the inversion — a legend that flips while
      // the fill does not is worse than no inversion at all.
      const painted = decodeStep(
        (provinceColorExpr(fc, null, { invert: true }) as unknown as unknown[])[3] as unknown[],
      );
      const paintedNormal = decodeStep(
        (provinceColorExpr(fc, null) as unknown as unknown[])[3] as unknown[],
      );
      const scale = provinceSeqClassScale(fc, null, { invert: true });
      expect(scale?.colors).toEqual(painted.colors);
      expect(scale?.breaks).toEqual(painted.breaks);
      // The FILL itself must flip — not only the legend it is lifted into.
      expect(painted.colors).toEqual([...paintedNormal.colors].reverse());
    });
  });
});

describe("provinceMetaColorExpr — META'd rate layers (PO: classed threshold scale, NOT divergent)", () => {
  const fc = provinceFC([
    { provinceCode: "AR-B", value: 34 }, // <40 → class 0
    { provinceCode: "AR-X", value: 55 }, // 40–60 → class 1
    { provinceCode: "AR-S", value: 72 }, // 60–80 → class 2
    { provinceCode: "AR-M", value: 88 }, // ≥80 (meta) → class 3
  ]);

  it("builds a case→match→step (classed) expression, NOT an interpolate (no continuous scale)", () => {
    const expr = provinceMetaColorExpr(fc, 80) as unknown as unknown[];
    expect(expr[0]).toBe("case");
    // The no-data short-circuit stays in front of the step (k-anon honesty).
    expect(expr[2]).toBe(COLOR_NO_DATA);
    const body = expr[3] as unknown[];
    expect(body[0]).toBe("step");
    // Must NOT be a continuous interpolation.
    expect(body[0]).not.toBe("interpolate");
    // Value lookup joins on the LOCAL polygon `code`.
    const valueMatch = (expr[1] as unknown[])[1] as unknown[];
    expect(valueMatch[0]).toBe("match");
    expect(valueMatch[1]).toEqual(["get", "code"]);
  });

  it("uses the META breaks [0.5T, 0.75T, T] — T=80 → [40, 60, 80]", () => {
    const { breaks, colors } = decodeStep(
      (provinceMetaColorExpr(fc, 80) as unknown as unknown[])[3] as unknown[],
    );
    expect(breaks).toEqual([40, 60, 80]);
    // 3 breaks → 4 classes; low anchor + high anchor of the dark ramp.
    expect(colors).toHaveLength(4);
    expect(colors[0]).toBe(SCALE_BLUE_SEQ[0]);
    expect(colors[colors.length - 1]).toBe(SCALE_BLUE_SEQ[SCALE_BLUE_SEQ.length - 1]);
  });

  it("uses the META breaks for a non-round target — T=70 → [35, 52.5, 70]", () => {
    const { breaks } = decodeStep(
      (provinceMetaColorExpr(fc, 70) as unknown as unknown[])[3] as unknown[],
    );
    expect(breaks).toEqual([35, 52.5, 70]);
  });

  it("returns a flat COLOR_NO_DATA when the feature collection is empty", () => {
    expect(provinceMetaColorExpr(provinceFC([]), 80)).toBe(COLOR_NO_DATA);
  });

  it("carries each province code → value pair in the match lookup", () => {
    const match = (provinceMetaColorExpr(fc, 80) as unknown as unknown[])[1] as unknown[];
    expect(match[0]).toBe("==");
    const valueMatch = match[1] as unknown[];
    expect(valueMatch[0]).toBe("match");
    expect(valueMatch[1]).toEqual(["get", "code"]);
    expect(valueMatch).toContain("AR-B");
    expect(valueMatch).toContain(34);
    expect(valueMatch).toContain("AR-M");
    expect(valueMatch).toContain(88);
  });
});

describe("provinceMetaClassScale — lifted legend scale (map/legend parity for META layers)", () => {
  const fc = provinceFC([
    { provinceCode: "AR-B", value: 34 },
    { provinceCode: "AR-M", value: 88 },
  ]);

  it("returns null when there are no numeric values", () => {
    expect(provinceMetaClassScale(provinceFC([]), 80)).toBeNull();
  });

  it("returns the META breaks [40, 60, 80] for T=80 (frame-stable, value-independent)", () => {
    const scale = provinceMetaClassScale(fc, 80);
    expect(scale?.method).toBe("meta");
    expect(scale?.breaks).toEqual([40, 60, 80]);
  });

  it("legend swatch ranges EXACTLY equal the painted step breaks (the DoD parity check)", () => {
    const scale = provinceMetaClassScale(fc, 80);
    expect(scale).not.toBeNull();
    // The off-canvas legend swatches are built from `scale`; the map paints the
    // step expression. Their break boundaries MUST be identical.
    const painted = decodeStep(
      (provinceMetaColorExpr(fc, 80) as unknown as unknown[])[3] as unknown[],
    );
    // Interior swatch boundaries (drop the open-below lo and open-above hi nulls).
    const swatchBreaks = classSwatches(scale as NonNullable<typeof scale>)
      .map((s) => s.hi)
      .filter((h): h is number => h !== null);
    expect(swatchBreaks).toEqual(painted.breaks);
    expect(swatchBreaks).toEqual([40, 60, 80]);
    // Colors line up class-for-class too.
    expect(scale?.colors).toEqual(painted.colors);
  });
});

describe("provinceValueBounds", () => {
  it("returns the value min/max for the legend", () => {
    const bounds = provinceValueBounds(
      provinceFC([
        { provinceCode: "AR-B", value: 61 },
        { provinceCode: "AR-X", value: 9 },
        { provinceCode: "AR-S", value: 7 },
      ]),
    );
    expect(bounds).toEqual({ min: 7, max: 61 });
  });

  it("returns null when there are no numeric values", () => {
    expect(provinceValueBounds(provinceFC([]))).toBeNull();
  });
});

describe("provinceNoDataFilter (D.5(b) — the stipple overlay)", () => {
  it("is a constant-TRUE filter when the layer has no values at all", () => {
    // The case the 2026-07-28 live review actually hit: a vista whose whole
    // mainland was COLOR_NO_DATA and read as bare basemap (the two are only
    // ΔE00 1.48 apart). Every province carries the mark, which is the honest
    // picture — "we know nothing here", not "this is background".
    expect(provinceNoDataFilter(provinceFC([]))).toBe(true);
  });

  it("selects the COMPLEMENT of the provinces that carry a value", () => {
    const filter = provinceNoDataFilter(
      provinceFC([
        { provinceCode: "AR-B", value: 12 },
        { provinceCode: "AR-C", value: 40 },
      ]),
    ) as unknown[];
    expect(filter[0]).toBe("!");
    const match = filter[1] as unknown[];
    expect(match[0]).toBe("match");
    // Keyed on the POLYGON property, not the cell property — the overlay reads
    // the basemap the fill paints.
    expect(match[1]).toEqual(["get", "code"]);
    expect(match[2]).toEqual(expect.arrayContaining(["AR-B", "AR-C"]));
  });

  it("stipples a province whose value is non-finite (absent, not zero)", () => {
    // provincePairs drops NaN, so the fill would render it COLOR_NO_DATA. The
    // overlay has to agree: fill and mark must never disagree about who has data.
    const filter = provinceNoDataFilter(
      provinceFC([
        { provinceCode: "AR-B", value: Number.NaN },
        { provinceCode: "AR-C", value: 7 },
      ]),
    ) as unknown[];
    const known = (filter[1] as unknown[])[2] as string[];
    expect(known).toEqual(["AR-C"]);
    expect(known).not.toContain("AR-B");
  });

  // ── #40: THE TRAP. A suppressed province has no value, so the naive
  // complement would stipple it — rendering "nadie reportó acá" over a province
  // that reported fine. That is a LIE and, worse, a LEAK: the single province
  // wearing the wrong texture is exactly the one whose count is sub-k.
  it("treats a SUPPRESSED province as KNOWN, never stippling it as no-data", () => {
    const filter = provinceNoDataFilter(
      provinceFC([
        { provinceCode: "AR-B", value: 12 },
        { provinceCode: "AR-Z", value: null, suppressed: true },
      ]),
    ) as unknown[];
    const known = (filter[1] as unknown[])[2] as string[];
    expect(known).toContain("AR-Z");
    expect(known).toEqual(expect.arrayContaining(["AR-B", "AR-Z"]));
  });

  it("still stipples a null-valued province that is NOT suppressed", () => {
    // The two states must stay separable: hatch = protected, stipple = nothing
    // reported. Suppression is read off the FLAG, never inferred from a null.
    const filter = provinceNoDataFilter(
      provinceFC([
        { provinceCode: "AR-B", value: 12 },
        { provinceCode: "AR-Z", value: null, suppressed: false },
      ]),
    ) as unknown[];
    const known = (filter[1] as unknown[])[2] as string[];
    expect(known).toEqual(["AR-B"]);
    expect(known).not.toContain("AR-Z");
  });

  it("is NOT constant-true when every cell is suppressed (all protected != all unknown)", () => {
    const filter = provinceNoDataFilter(
      provinceFC([{ provinceCode: "AR-Z", value: null, suppressed: true }]),
    );
    expect(filter).not.toBe(true);
  });
});

describe("provinceSuppressedCodes / hasSuppressedProvince (#40 — the hatch set)", () => {
  it("collects the codes flagged suppressed", () => {
    const fc = provinceFC([
      { provinceCode: "AR-B", value: 12 },
      { provinceCode: "AR-Z", value: null, suppressed: true },
      { provinceCode: "AR-U", value: null, suppressed: true },
    ]);
    expect(provinceSuppressedCodes(fc)).toEqual(["AR-Z", "AR-U"]);
    expect(hasSuppressedProvince(fc)).toBe(true);
  });

  it("reads the FLAG, not a null value — an unflagged null is absent, not protected", () => {
    const fc = provinceFC([{ provinceCode: "AR-Z", value: null, suppressed: false }]);
    expect(provinceSuppressedCodes(fc)).toEqual([]);
    expect(hasSuppressedProvince(fc)).toBe(false);
  });

  it("is empty (and hasSuppressedProvince false) for a fully visible layer", () => {
    const fc = provinceFC([{ provinceCode: "AR-B", value: 12 }]);
    expect(provinceSuppressedCodes(fc)).toEqual([]);
    expect(hasSuppressedProvince(fc)).toBe(false);
  });
});

describe("provinceCellAt (#40 — the popup lookup that used to publish a false 0)", () => {
  const fc = provinceFC([
    { provinceCode: "AR-B", value: 12 },
    { provinceCode: "AR-Z", value: null, suppressed: true },
  ]);

  it("returns NULL, never 0, for a suppressed province", () => {
    // `p.value ?? 0` was the bug: on a coverage layer a confident "0" is the
    // most alarming reading available, invented for a cell that has no value.
    expect(provinceCellAt(fc, "AR-Z")).toEqual({ value: null, suppressed: true });
    expect(provinceCellAt(fc, "AR-Z").value).not.toBe(0);
  });

  it("returns the real value for a visible province", () => {
    expect(provinceCellAt(fc, "AR-B")).toEqual({ value: 12, suppressed: false });
  });

  it("distinguishes ABSENT from SUPPRESSED — both valueless, only one protected", () => {
    expect(provinceCellAt(fc, "AR-X")).toEqual({ value: null, suppressed: false });
  });

  it("tolerates an undefined feature collection", () => {
    expect(provinceCellAt(undefined, "AR-B")).toEqual({ value: null, suppressed: false });
  });
});

// RA-7 F9 — the gate the legend's "Sin datos" key must pass. It rendered
// unconditionally on every province legend, so a frame in which all 24
// jurisdictions report still named a stipple the canvas does not paint.
describe("provincePaintsNoData", () => {
  function fc(
    cells: Array<{ code: string; value: number | null; suppressed?: boolean }>,
  ): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: cells.map((c) => ({
        type: "Feature",
        geometry: null,
        properties: { provinceCode: c.code, value: c.value, suppressed: c.suppressed === true },
      })),
    } as unknown as FeatureCollection;
  }

  it("is false when all 24 jurisdictions carry a value — nothing is stippled", () => {
    expect(provincePaintsNoData(fc(PROVINCES.map((p) => ({ code: p.code, value: 12 }))))).toBe(
      false,
    );
  });

  it("is true when even ONE jurisdiction is missing from the layer", () => {
    expect(
      provincePaintsNoData(
        fc(PROVINCES.slice(0, PROVINCES.length - 1).map((p) => ({ code: p.code, value: 12 }))),
      ),
    ).toBe(true);
  });

  it("treats a SUPPRESSED province as accounted-for, exactly like provinceNoDataFilter", () => {
    // The trap the filter documents: a suppressed cell carries value null, so a
    // naive complement stipples the one province whose count is sub-k — both a
    // lie ("nadie reportó acá") and a leak (the odd texture points at it).
    const cells = PROVINCES.map((p, i) =>
      i === 0 ? { code: p.code, value: null, suppressed: true } : { code: p.code, value: 12 },
    );
    expect(provincePaintsNoData(fc(cells))).toBe(false);
    // …and the filter agrees: the suppressed code is inside the known set.
    expect(JSON.stringify(provinceNoDataFilter(fc(cells)))).toContain(PROVINCES[0].code);
  });

  it("is true for an empty layer — the filter stipples the whole country there", () => {
    expect(provincePaintsNoData(fc([]))).toBe(true);
  });

  it("does not count a NaN-valued cell as accounted-for (same hardening as the fill)", () => {
    // provincePairs drops non-finite values, so the fill routes them to
    // COLOR_NO_DATA and the stipple covers them. The key must follow.
    const cells = PROVINCES.map((p, i) => ({ code: p.code, value: i === 0 ? Number.NaN : 12 }));
    expect(provincePaintsNoData(fc(cells))).toBe(true);
  });
});
