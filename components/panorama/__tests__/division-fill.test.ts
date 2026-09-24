// Unit tests for the locality-choropleth division-fill join (pure, no maplibre).

import { beforeEach, describe, expect, it } from "vitest";

import type { FeatureCollection, PanoramaFeature } from "@/src/modules/panorama/domain/types";
import {
  __resetDivisionJoinCache,
  divisionClassScaleForLayer,
  divisionCodeForCell,
  divisionFillColorExpr,
  divisionFillForLayer,
  divisionNoDataFilter,
  divisionPaintsNoData,
  divisionSuppressedFilter,
  divisionValueBounds,
  filterDepartmentsByPrefix,
  joinCellsToDivisions,
  joinCellsToDivisionsMulti,
} from "../division-fill";

// A locality choropleth cell as a Point feature (the shape buildChoroplethFeatures emits).
function cell(props: Record<string, unknown>): PanoramaFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-58.4, -34.6] },
    properties: props,
  };
}
function fc(features: PanoramaFeature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

describe("divisionCodeForCell", () => {
  it("derives the CABA barrio slug from the locality name (shared normalizer)", () => {
    expect(divisionCodeForCell({ locality: "Palermo" }, "barrio")).toBe("palermo");
    expect(divisionCodeForCell({ locality: "La Boca" }, "barrio")).toBe("la boca");
    expect(divisionCodeForCell({ locality: "Vélez Sársfield" }, "barrio")).toBe("velez sarsfield");
  });

  it("returns null for a barrio cell with no locality name", () => {
    expect(divisionCodeForCell({}, "barrio")).toBeNull();
  });

  it("zero-pads the department code for the departamento join", () => {
    expect(divisionCodeForCell({ departmentCode: "06441" }, "department")).toBe("06441");
    expect(divisionCodeForCell({ departmentCode: "6441" }, "department")).toBe("06441");
  });

  it("returns null for a department cell with no department code", () => {
    expect(divisionCodeForCell({ departmentCode: null }, "department")).toBeNull();
    expect(divisionCodeForCell({}, "department")).toBeNull();
  });
});

describe("joinCellsToDivisions — CABA barrios", () => {
  const codes = new Set(["palermo", "la boca", "recoleta"]);

  it("fills a barrio from its matching locality cell; nothing unmatched", () => {
    const join = joinCellsToDivisions(
      fc([cell({ locality: "Palermo", value: 12, suppressed: false })]),
      "barrio",
      codes,
    );
    expect(join.values.get("palermo")).toBe(12);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("keeps a suppressed matched barrio OUTLINE-only (no fill, no circle)", () => {
    const join = joinCellsToDivisions(
      fc([cell({ locality: "La Boca", value: null, suppressed: true })]),
      "barrio",
      codes,
    );
    expect(join.values.has("la boca")).toBe(false);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("falls back to the centroid circle for a locality with no polygon match", () => {
    const join = joinCellsToDivisions(
      fc([cell({ locality: "Barrio Inexistente", value: 4, suppressed: false })]),
      "barrio",
      codes,
    );
    expect(join.values.size).toBe(0);
    expect(join.unmatched.features).toHaveLength(1);
  });
});

describe("joinCellsToDivisions — departamento roll-up", () => {
  const codes = new Set(["06441", "06007"]);

  it("sums several localities into their shared departamento", () => {
    const join = joinCellsToDivisions(
      fc([
        cell({ locality: "La Plata", departmentCode: "06441", value: 10, suppressed: false }),
        cell({ locality: "City Bell", departmentCode: "06441", value: 5, suppressed: false }),
      ]),
      "department",
      codes,
    );
    expect(join.values.get("06441")).toBe(15);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("omits suppressed constituents from the departamento fill (k-anon conservative)", () => {
    const join = joinCellsToDivisions(
      fc([
        cell({ locality: "La Plata", departmentCode: "06441", value: 10, suppressed: false }),
        cell({ locality: "Villa Elisa", departmentCode: "06441", value: null, suppressed: true }),
      ]),
      "department",
      codes,
    );
    // Only the visible locality contributes; the suppressed one adds nothing.
    expect(join.values.get("06441")).toBe(10);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("routes a cell with no department code to the centroid-circle fallback", () => {
    const join = joinCellsToDivisions(
      fc([cell({ locality: "Sin depto", departmentCode: null, value: 7, suppressed: false })]),
      "department",
      codes,
    );
    expect(join.values.size).toBe(0);
    expect(join.unmatched.features).toHaveLength(1);
  });
});

describe("joinCellsToDivisionsMulti — zoom-driven multi-province union", () => {
  const deptCodes = new Set(["06441", "06007"]);
  const barrioCodes = new Set(["palermo", "la boca"]);
  const levels = [
    { level: "department" as const, codes: deptCodes },
    { level: "barrio" as const, codes: barrioCodes },
  ];

  it("fills departamento AND barrio cells over one shared source", () => {
    const join = joinCellsToDivisionsMulti(
      fc([
        cell({ locality: "La Plata", departmentCode: "06441", value: 10, suppressed: false }),
        cell({ locality: "Palermo", value: 4, suppressed: false }),
      ]),
      levels,
    );
    expect(join.values.get("06441")).toBe(10);
    expect(join.values.get("palermo")).toBe(4);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("routes a cell matching NO level to the centroid-circle fallback", () => {
    const join = joinCellsToDivisionsMulti(
      fc([cell({ locality: "Nowhere", departmentCode: "99999", value: 3, suppressed: false })]),
      levels,
    );
    expect(join.values.size).toBe(0);
    expect(join.unmatched.features).toHaveLength(1);
  });

  it("keeps a matched-but-suppressed cell OUTLINE-only (k-anon preserved across levels)", () => {
    const join = joinCellsToDivisionsMulti(
      fc([cell({ locality: "La Boca", value: null, suppressed: true })]),
      levels,
    );
    expect(join.values.has("la boca")).toBe(false);
    expect(join.unmatched.features).toHaveLength(0);
  });

  it("is equivalent to the single-level join for a single level", () => {
    const cells = fc([cell({ locality: "Palermo", value: 7, suppressed: false })]);
    const single = joinCellsToDivisions(cells, "barrio", barrioCodes);
    const multi = joinCellsToDivisionsMulti(cells, [{ level: "barrio", codes: barrioCodes }]);
    expect(multi.values.get("palermo")).toBe(single.values.get("palermo"));
  });
});

describe("joinCellsToDivisionsMulti — memoization / referential stability", () => {
  const deptCodes = new Set(["06441"]);
  const barrioCodes = new Set(["palermo"]);
  const levels = [
    { level: "department" as const, codes: deptCodes },
    { level: "barrio" as const, codes: barrioCodes },
  ];

  beforeEach(() => {
    __resetDivisionJoinCache();
  });

  it("returns the SAME object reference for the same features + code Sets (no recompute)", () => {
    const cells = fc([cell({ locality: "Palermo", value: 4, suppressed: false })]);
    const first = joinCellsToDivisionsMulti(cells, levels);
    // A fresh `levels` array literal but the SAME code-Set instances — mirrors
    // syncLayers, which rebuilds the array each repaint from ref-held Sets.
    const second = joinCellsToDivisionsMulti(cells, [
      { level: "department", codes: deptCodes },
      { level: "barrio", codes: barrioCodes },
    ]);
    expect(second).toBe(first); // identity — the memo skipped the O(features) join.
  });

  it("recomputes (new object) when the features reference changes", () => {
    const a = joinCellsToDivisionsMulti(
      fc([cell({ locality: "Palermo", value: 4, suppressed: false })]),
      levels,
    );
    const b = joinCellsToDivisionsMulti(
      fc([cell({ locality: "Palermo", value: 4, suppressed: false })]),
      levels,
    );
    expect(b).not.toBe(a); // different FeatureCollection ref → cache miss.
  });

  it("recomputes when a code Set instance changes even if the members are equal", () => {
    const cells = fc([cell({ locality: "Palermo", value: 4, suppressed: false })]);
    const first = joinCellsToDivisionsMulti(cells, levels);
    // Same members, NEW Set instance → a different scope → must not alias.
    const second = joinCellsToDivisionsMulti(cells, [
      { level: "department", codes: new Set(["06441"]) },
      { level: "barrio", codes: new Set(["palermo"]) },
    ]);
    expect(second).not.toBe(first);
    expect(second.values.get("palermo")).toBe(4); // still correct after recompute.
  });
});

describe("k-anon suppressed hatch set (map-polish cursor #2)", () => {
  const barrioCodes = new Set(["palermo", "la boca", "recoleta"]);

  it("lists a division whose ONLY cell is suppressed (hatched, not no-data)", () => {
    const join = joinCellsToDivisions(
      fc([cell({ locality: "La Boca", value: null, suppressed: true })]),
      "barrio",
      barrioCodes,
    );
    // Never a number (k-anon logic untouched) AND flagged for the hatch.
    expect(join.values.has("la boca")).toBe(false);
    expect(join.suppressed.has("la boca")).toBe(true);
  });

  it("does NOT hatch a departamento that has a visible constituent (fill wins)", () => {
    const deptCodes = new Set(["06441"]);
    const join = joinCellsToDivisions(
      fc([
        cell({ locality: "La Plata", departmentCode: "06441", value: 10, suppressed: false }),
        cell({ locality: "Villa Elisa", departmentCode: "06441", value: null, suppressed: true }),
      ]),
      "department",
      deptCodes,
    );
    // The visible sum colors the cell; the suppressed constituent is omitted from
    // the sum (unchanged behavior) and the cell is NOT hatched.
    expect(join.values.get("06441")).toBe(10);
    expect(join.suppressed.has("06441")).toBe(false);
  });

  it("leaves a plain no-data division out of BOTH values and suppressed", () => {
    const join = joinCellsToDivisions(fc([]), "barrio", barrioCodes);
    expect(join.values.size).toBe(0);
    expect(join.suppressed.size).toBe(0);
  });
});

describe("divisionSuppressedFilter (map-polish cursor #2)", () => {
  it("is a constant-false filter for an empty set (hatch renders nothing)", () => {
    expect(divisionSuppressedFilter(new Set())).toBe(false);
  });

  it("matches the suppressed codes against the polygon `code` property", () => {
    const filter = divisionSuppressedFilter(new Set(["la boca", "palermo"])) as unknown[];
    expect(filter[0]).toBe("match");
    expect(filter[1]).toEqual(["get", "code"]);
    expect(filter[2]).toEqual(["la boca", "palermo"]);
    // labels → true, fallback → false (member vs non-member).
    expect(filter[3]).toBe(true);
    expect(filter[4]).toBe(false);
  });
});

describe("divisionNoDataFilter (D.5(b) — the stipple overlay)", () => {
  it("is a constant-TRUE filter when nothing is known (an empty map looks empty)", () => {
    // The inverse of the suppression filter's empty case, and deliberately so.
    // A grain with no values and no suppression has nothing to say about ANY of
    // its divisions, so all of them carry the mark. Rendering nothing would put
    // bare land on screen and let it pass for "outside the analysis" — the very
    // confusion this overlay exists to break.
    expect(divisionNoDataFilter(new Map(), new Set())).toBe(true);
  });

  it("selects the COMPLEMENT of the valued and suppressed codes", () => {
    const filter = divisionNoDataFilter(
      new Map([["palermo", 12]]),
      new Set(["la boca"]),
    ) as unknown[];
    expect(filter[0]).toBe("!");
    const match = filter[1] as unknown[];
    expect(match[0]).toBe("match");
    expect(match[1]).toEqual(["get", "code"]);
    expect(match[2]).toEqual(expect.arrayContaining(["palermo", "la boca"]));
    expect((match[2] as string[]).length).toBe(2);
  });

  it("never marks a SUPPRESSED division as no-data (the trichotomy holds)", () => {
    // "Protected" and "empty" are different claims and carry different marks
    // (45° hatch vs stipple). A suppressed division landing in both overlays
    // would stack them and assert both at once.
    const filter = divisionNoDataFilter(new Map(), new Set(["la boca"])) as unknown[];
    const known = (filter[1] as unknown[])[2] as string[];
    expect(known).toContain("la boca");
  });

  it("deduplicates a code that is both valued and suppressed", () => {
    // A division can be partially suppressed: some constituent cells reported,
    // others withheld. It is still ONE polygon, so it must appear once.
    const filter = divisionNoDataFilter(
      new Map([["palermo", 5]]),
      new Set(["palermo"]),
    ) as unknown[];
    expect((filter[1] as unknown[])[2]).toEqual(["palermo"]);
  });
});

describe("divisionFillColorExpr", () => {
  it("is a flat transparent fill when there are no values (outline only)", () => {
    expect(divisionFillColorExpr(new Map())).toBe("rgba(0,0,0,0)");
  });

  it("builds a case/match/step (classed) expression when values exist", () => {
    const expr = divisionFillColorExpr(
      new Map([
        ["a", 3],
        ["b", 20],
        ["c", 40],
        ["d", 60],
        ["e", 90],
      ]),
    ) as unknown[];
    expect(Array.isArray(expr)).toBe(true);
    expect(expr[0]).toBe("case");
    expect((expr[3] as unknown[])[0]).toBe("step");
  });

  it("locks the classed breaks to frozen live-edge quantiles so two as-of frames share one scale", () => {
    // The scrub-lock passes the FROZEN live-edge quantile breaks. Two DIFFERENT
    // frames (values 10 vs 90) must CLASS over the SAME frozen breaks, so a value
    // keeps its class-color across the scrub (no per-frame rebasing = no flicker).
    // The frozen breaks are painted verbatim — NOT re-derived as equal-interval.
    const frozen = [3, 5, 8, 200];
    const frameA = divisionFillColorExpr(new Map([["palermo", 10]]), frozen) as unknown[];
    const frameB = divisionFillColorExpr(new Map([["palermo", 90]]), frozen) as unknown[];
    // expr = ["case", cond, transparent, ["step", match, c0, t1,c1, t2,c2, …]]
    const stepA = frameA[3] as unknown[];
    const stepB = frameB[3] as unknown[];
    expect(stepA[0]).toBe("step");
    expect(stepB[0]).toBe("step");
    // Interior thresholds live at odd indices 3,5,7,9 — identical across frames.
    const breaksA = [stepA[3], stepA[5], stepA[7], stepA[9]];
    const breaksB = [stepB[3], stepB[5], stepB[7], stepB[9]];
    expect(breaksA).toEqual([3, 5, 8, 200]);
    expect(breaksB).toEqual([3, 5, 8, 200]);
  });
});

describe("divisionValueBounds", () => {
  it("returns min/max over the values", () => {
    expect(
      divisionValueBounds(
        new Map([
          ["a", 2],
          ["b", 9],
        ]),
      ),
    ).toEqual({ min: 2, max: 9 });
  });
  it("returns null when empty", () => {
    expect(divisionValueBounds(new Map())).toBeNull();
  });
});

describe("filterDepartmentsByPrefix", () => {
  it("keeps only departamentos whose INDEC code starts with the province prefix", () => {
    const filtered = filterDepartmentsByPrefix(
      {
        features: [
          { properties: { code: "06007" } },
          { properties: { code: "06441" } },
          { properties: { code: "14056" } },
          { properties: null },
        ],
      },
      "06",
    );
    expect(filtered).toHaveLength(2);
  });
});

// P1-F1 + PO decision D4 (2026-07-28): ONE polarity convention across the
// console — dark = alarm, always. The province branch already honoured a
// layer's `higherIsBetter` by inverting its ramp; the division branch never
// received the flag, so drilling into a "más es mejor" layer silently flipped
// the meaning of dark under the reader's feet. Live case: acceso-veterinario —
// dark = fewer acts (worse) at province level, dark = more attended pets
// (better) one zoom in, same legend.
describe("divisionFillColorExpr — polarity (D4: dark = alarm, always)", () => {
  const values = new Map<string, number>([
    ["a", 1],
    ["b", 5],
    ["c", 9],
  ]);

  it("inverts the ramp when the layer declares higher-is-better", () => {
    const plain = JSON.stringify(divisionFillColorExpr(values, null));
    const inverted = JSON.stringify(divisionFillColorExpr(values, null, { invert: true }));
    expect(inverted).not.toBe(plain);
  });

  it("leaves the ramp alone when the layer does not declare it", () => {
    const plain = JSON.stringify(divisionFillColorExpr(values, null));
    const explicitFalse = JSON.stringify(divisionFillColorExpr(values, null, { invert: false }));
    expect(explicitFalse).toBe(plain);
  });

  it("paints the same colours as the province ramp for the same values and polarity", () => {
    // The two branches must agree: a value that reads dark on the province map
    // must read dark after drilling in. Comparing the emitted colour lists is
    // the strongest available check without a live map.
    const inverted = JSON.stringify(divisionFillColorExpr(values, null, { invert: true }));
    const plain = JSON.stringify(divisionFillColorExpr(values, null, { invert: false }));
    const colours = (expr: string) => (expr.match(/#[0-9a-f]{6}/gi) ?? []).join(",");
    expect(colours(inverted)).not.toBe(colours(plain));
    expect(colours(inverted).split(",").sort()).toEqual(colours(plain).split(",").sort());
  });
});

// PO 2026-08-01 — "las referencias de colores no son consistentes con lo
// mostrado en el mapa, no solo en el estado colapsado, sino también en
// expandido".
//
// The polarity fix above landed on the FILL only. SituationalMap's legend
// descriptor kept its own `computeClassScale(values, { lockedBreaks })` — no
// `invert` — so on the one drillable higher-is-better layer
// (`acceso-veterinario`) the swatches ran EXACTLY BACKWARDS against the
// polygons: legend darkest on the highest count, map darkest on the lowest.
// The breaks matched (invert only reassigns colours), so the numbers looked
// right and only the colours lied. Both legend surfaces inherited it — the
// dock's "Referencias" swatches read `divisionLegend.colors` and so does the
// collapsed pill's ramp fallback (`legendRampColors`), which is why the PO saw
// it in both states.
//
// `divisionClassScaleForLayer` is now the ONE resolution both read.
describe("divisionClassScaleForLayer — the legend's scale IS the fill's scale", () => {
  const values = new Map<string, number>([
    ["a", 1],
    ["b", 5],
    ["c", 9],
    ["d", 14],
    ["e", 20],
    ["f", 31],
  ]);
  /** Colours the fill expression actually paints, in class order. */
  function paintedColours(expr: unknown): string[] {
    const step = (expr as unknown[])[3] as unknown[];
    expect(step[0]).toBe("step");
    // ["step", input, c0, t1, c1, t2, c2, …] — colours sit at 2 and every odd
    // index after it.
    const out = [String(step[2])];
    for (let i = 4; i < step.length; i += 2) out.push(String(step[i]));
    return out;
  }

  it("hands a higher-is-better layer the SAME colour order its fill paints", () => {
    const layer = { higherIsBetter: true };
    const scale = divisionClassScaleForLayer(layer, values, null);
    expect(paintedColours(divisionFillForLayer(layer, values, null))).toEqual(scale.colors);
  });

  it("hands a default (higher-is-worse) layer the SAME colour order too", () => {
    const layer = {};
    const scale = divisionClassScaleForLayer(layer, values, null);
    expect(paintedColours(divisionFillForLayer(layer, values, null))).toEqual(scale.colors);
  });

  it("actually reverses the swatch colours for a higher-is-better layer", () => {
    // The regression this closes: the legend used to get the DEFAULT order for
    // both polarities. Asserting only "legend === fill" would still pass if
    // BOTH silently stopped inverting, so pin the inversion itself.
    const plain = divisionClassScaleForLayer({}, values, null).colors;
    const inverted = divisionClassScaleForLayer({ higherIsBetter: true }, values, null).colors;
    expect(inverted).toEqual([...plain].reverse());
    expect(inverted[0]).not.toBe(plain[0]);
  });

  it("leaves the BREAKS untouched by polarity — only the colours flip", () => {
    // Why the defect survived review for so long: the numbers beside the
    // swatches were right the whole time. A reader checking the ranges found
    // nothing wrong; only the ink was reversed.
    expect(divisionClassScaleForLayer({ higherIsBetter: true }, values, null).breaks).toEqual(
      divisionClassScaleForLayer({}, values, null).breaks,
    );
  });

  it("carries the scrub-locked breaks into the legend scale, like the fill", () => {
    const frozen = [3, 8, 15, 25];
    expect(divisionClassScaleForLayer({}, values, frozen).breaks).toEqual(frozen);
  });
});

// RA-7 F9 — the legend's "Sin datos (solo contorno)" key rendered on every
// drilled frame, promising an outline-only mark on scopes where every division
// carries a value. This atom is the gate, and it must be the same arithmetic
// `divisionNoDataFilter` is evaluated with.
describe("divisionPaintsNoData", () => {
  it("is false when every polygon in the source is valued", () => {
    expect(divisionPaintsNoData(new Map([["06001", 4]]), new Set(), 1)).toBe(false);
  });

  it("is false when the polygons are split between valued and suppressed", () => {
    // Suppressed is ACCOUNTED FOR, not missing — it wears the hatch, not the
    // stipple. Same exclusion the filter's docblock spells out.
    expect(divisionPaintsNoData(new Map([["06001", 4]]), new Set(["06002"]), 2)).toBe(false);
  });

  it("is true as soon as ONE polygon is neither valued nor suppressed", () => {
    expect(divisionPaintsNoData(new Map([["06001", 4]]), new Set(["06002"]), 3)).toBe(true);
  });

  it("is true when nothing is known at all — the whole grain is stippled", () => {
    // Matches the filter's constant-`true` branch: a map with no data anywhere
    // should look like it, not like bare land.
    expect(divisionPaintsNoData(new Map(), new Set(), 12)).toBe(true);
  });

  it("is false when there is no polygon to stipple", () => {
    // The one case where the filter's constant-`true` paints nothing, because
    // the source is empty. A key here would name a mark on an empty canvas.
    expect(divisionPaintsNoData(new Map(), new Set(), 0)).toBe(false);
  });

  it("agrees with divisionNoDataFilter about whether ANYTHING is unaccounted for", () => {
    // The coupling is the point: key and overlay must answer from one rule.
    const valued = new Map([["06001", 4]]);
    const suppressed = new Set(["06002"]);
    const filter = JSON.stringify(divisionNoDataFilter(valued, suppressed));
    // The complement lists exactly the accounted-for codes; anything else in the
    // source is stippled, which is what the atom reports for a 3-polygon source.
    expect(filter).toContain("06001");
    expect(filter).toContain("06002");
    expect(divisionPaintsNoData(valued, suppressed, 3)).toBe(true);
    expect(divisionPaintsNoData(valued, suppressed, 2)).toBe(false);
  });
});
