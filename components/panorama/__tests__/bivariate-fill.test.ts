// Tests for the bivariate client render helpers (task #63): palette layout, the
// fill/hatch expressions, the legend grid, and the pinned-popup readout.

import { describe, expect, it } from "vitest";

import {
  BIVARIATE_LEGEND_GRID,
  BIVARIATE_PALETTE,
  BIVARIATE_RISK_COLOR,
  bivariateCellColor,
  bivariateFillColorExpr,
  bivariateGreyStates,
  bivariateReadouts,
  bivariateSuppressedCodes,
  bivariateSuppressedFilter,
} from "@/components/panorama/bivariate-fill";
import type { BivariateCell } from "@/src/modules/panorama/domain/bivariate";
import { COLOR_NO_DATA } from "@dim/contract/viz";

function cell(over: Partial<BivariateCell>): BivariateCell {
  return {
    provinceCode: "AR-A",
    place: "Salta",
    coverageValue: 30,
    signalValue: 40,
    coverageClass: 0,
    signalClass: 2,
    suppressed: false,
    ...over,
  };
}

describe("palette + cell color", () => {
  it("has 9 cells and the risk corner is index 6", () => {
    expect(BIVARIATE_PALETTE).toHaveLength(9);
    expect(BIVARIATE_RISK_COLOR).toBe(BIVARIATE_PALETTE[6]);
  });

  it("colors a classified cell from its (cov, sig) index", () => {
    expect(bivariateCellColor(cell({ coverageClass: 0, signalClass: 2 }))).toBe(
      BIVARIATE_PALETTE[6],
    );
    expect(bivariateCellColor(cell({ coverageClass: 2, signalClass: 0 }))).toBe(
      BIVARIATE_PALETTE[2],
    );
  });

  it("withholds color for a suppressed OR no-data cell", () => {
    expect(bivariateCellColor(cell({ suppressed: true }))).toBeNull();
    expect(bivariateCellColor(cell({ coverageClass: null }))).toBeNull();
    expect(bivariateCellColor(cell({ signalClass: null }))).toBeNull();
  });
});

describe("fill-color expression", () => {
  it("builds a match on code → color, defaulting to no-data", () => {
    const expr = bivariateFillColorExpr([
      cell({ provinceCode: "AR-A", coverageClass: 0, signalClass: 2 }),
      cell({ provinceCode: "AR-B", coverageClass: 2, signalClass: 0 }),
    ]) as unknown as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr).toContain("AR-A");
    expect(expr).toContain("AR-B");
    expect(expr[expr.length - 1]).toBe(COLOR_NO_DATA);
  });

  it("suppressed cells are excluded from the color match", () => {
    const expr = bivariateFillColorExpr([
      cell({ provinceCode: "AR-A", suppressed: true }),
    ]) as unknown as unknown[];
    // Nothing classified → flat no-data expression, not a match.
    expect(expr).toBe(COLOR_NO_DATA);
  });
});

describe("suppression → hatch", () => {
  it("collects suppressed codes and builds a filter over them", () => {
    const cells = [
      cell({ provinceCode: "AR-A", suppressed: true }),
      cell({ provinceCode: "AR-B", suppressed: false }),
    ];
    expect(bivariateSuppressedCodes(cells)).toEqual(["AR-A"]);
    const filter = bivariateSuppressedFilter(["AR-A"]) as unknown[];
    expect(filter[0]).toBe("match");
    expect(bivariateSuppressedFilter([])).toBe(false);
  });
});

describe("legend grid", () => {
  it("is a 3×3 with the top-left cell being low-coverage/high-signal risk", () => {
    expect(BIVARIATE_LEGEND_GRID).toHaveLength(9);
    const first = BIVARIATE_LEGEND_GRID[0]; // top row (sig high), left col (cov low)
    expect(first.cov).toBe(0);
    expect(first.sig).toBe(2);
    expect(first.risk).toBe(true);
    expect(BIVARIATE_LEGEND_GRID.filter((s) => s.risk)).toHaveLength(1);
  });
});

describe("pinned-popup readout", () => {
  it("reports both raw values with class + a risk band", () => {
    const rows = bivariateReadouts(cell({ coverageValue: 48, signalValue: 12 }));
    expect(rows[0]).toMatchObject({ label: "Cobertura", valueText: "48% (baja)" });
    expect(rows[1]).toMatchObject({ label: "Señales", valueText: "12 (altas)" });
    expect(rows[2]).toMatchObject({ label: "Intensidad", valueText: "alto" });
  });

  it("a suppressed cell reports the protected state, never a value", () => {
    const rows = bivariateReadouts(cell({ suppressed: true }));
    expect(rows.every((r) => r.valueText === null && r.state === "suppressed")).toBe(true);
  });
});

// RA-7 F10 — which unclassifiable states the frame actually paints grey with.
// `bivariateFillColorExpr` sends three different situations to the SAME
// COLOR_NO_DATA default, and the legend named none of them. Two of the three
// ("falta un eje" vs "no reportó ninguna") are opposite conclusions for a
// municipality and cannot be told apart by hue, so the key has to state which
// ones this frame contains rather than pretend the colour resolves it.
describe("bivariateGreyStates", () => {
  it("reports neither state when every cell is fully classified", () => {
    expect(bivariateGreyStates([cell({}), cell({ provinceCode: "AR-X" })])).toEqual({
      missingAxis: false,
      noData: false,
    });
  });

  it("flags missingAxis when the SIGNAL half is absent", () => {
    expect(bivariateGreyStates([cell({ signalValue: null, signalClass: null })])).toEqual({
      missingAxis: true,
      noData: false,
    });
  });

  it("flags missingAxis when the COVERAGE half is absent", () => {
    expect(bivariateGreyStates([cell({ coverageValue: null, coverageClass: null })])).toEqual({
      missingAxis: true,
      noData: false,
    });
  });

  it("flags noData only when BOTH axes are absent", () => {
    expect(
      bivariateGreyStates([
        cell({
          coverageValue: null,
          coverageClass: null,
          signalValue: null,
          signalClass: null,
        }),
      ]),
    ).toEqual({ missingAxis: false, noData: true });
  });

  it("reports both when the frame contains both — never collapses them to one", () => {
    expect(
      bivariateGreyStates([
        cell({ signalValue: null, signalClass: null }),
        cell({
          provinceCode: "AR-X",
          coverageValue: null,
          coverageClass: null,
          signalValue: null,
          signalClass: null,
        }),
      ]),
    ).toEqual({ missingAxis: true, noData: true });
  });

  it("EXCLUDES suppressed cells — they carry their own mark and their own key", () => {
    // A suppressed cell is colourless too, but the hatch declares it. Folding it
    // in here would publish two readings for one polygon, and would leak the
    // suppressed unit into a key that describes absence.
    expect(
      bivariateGreyStates([
        cell({
          suppressed: true,
          coverageValue: null,
          coverageClass: null,
          signalValue: null,
          signalClass: null,
        }),
      ]),
    ).toEqual({ missingAxis: false, noData: false });
  });

  it("agrees with bivariateCellColor: every cell it flags is one the fill leaves grey", () => {
    // The coupling that matters — the key must describe the polygons the
    // expression actually defaults to COLOR_NO_DATA, not a parallel guess.
    const cells = [
      cell({}),
      cell({ provinceCode: "AR-X", signalValue: null, signalClass: null }),
      cell({
        provinceCode: "AR-S",
        coverageValue: null,
        coverageClass: null,
        signalValue: null,
        signalClass: null,
      }),
    ];
    const greyCount = cells.filter((c) => !c.suppressed && bivariateCellColor(c) === null).length;
    const flags = bivariateGreyStates(cells);
    expect(greyCount).toBe(2);
    expect(flags.missingAxis || flags.noData).toBe(true);
  });
});
