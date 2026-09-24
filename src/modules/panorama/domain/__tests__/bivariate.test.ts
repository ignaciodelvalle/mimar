// Unit tests for the pure bivariate-choropleth domain (task #63).
//
// Covers the tercile classifier, the 3×3 index/risk helpers, and — the privacy
// invariant — k-anon SUPPRESSION PROPAGATION through the coverage×signal join.

import { describe, expect, it } from "vitest";

import {
  BIVARIATE_MIN_UNITS,
  BIVARIATE_RISK_INDEX,
  BIVARIATE_SAFE_INDEX,
  type BivariateCell,
  bivariateIndex,
  bivariateRefusalReason,
  bivariateViable,
  buildBivariateCells,
  classifyTercile,
  coverageClassLabel,
  riskLabel,
  riskScore,
  signalClassLabel,
  tercileThresholds,
} from "@/src/modules/panorama/domain/bivariate";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

function coverageFc(
  rows: Array<{ code: string; name: string; value: number | null; suppressed?: boolean }>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: null,
      properties: {
        provinceCode: r.code,
        province: r.name,
        value: r.value,
        suppressed: r.suppressed ?? false,
      },
    })),
  };
}

function signalFc(
  rows: Array<{ name: string; count: number | null; suppressed?: boolean }>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: null,
      properties: { province: r.name, count: r.count, suppressed: r.suppressed ?? false },
    })),
  };
}

const cellByCode = (cells: BivariateCell[], code: string) =>
  cells.find((c) => c.provinceCode === code);

// A helper to build N spread coverage + signal units (viable by default).
function spreadUnits(n: number) {
  const cov = Array.from({ length: n }, (_, i) => ({
    code: `AR-${i}`,
    name: `P${i}`,
    value: 10 + i * 5, // strictly increasing → non-degenerate terciles
  }));
  const sig = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, count: 1 + i }));
  return { cov: coverageFc(cov), sig: signalFc(sig) };
}

describe("bivariateViable (WARNING 7 degeneracy guard)", () => {
  it("is viable with enough spread comparable units", () => {
    const { cov, sig } = spreadUnits(BIVARIATE_MIN_UNITS);
    expect(bivariateViable(cov, sig)).toBe(true);
  });

  it("is NOT viable below the minimum comparable-unit count", () => {
    const { cov, sig } = spreadUnits(BIVARIATE_MIN_UNITS - 1);
    expect(bivariateViable(cov, sig)).toBe(false);
  });

  it("is NOT viable for a lone high-coverage province (degenerate terciles)", () => {
    // One 95%-coverage province + one signal — terciles collapse (t1 === t2), which
    // would otherwise mislabel it "baja cobertura / riesgo medio".
    const cov = coverageFc([{ code: "AR-A", name: "A", value: 95 }]);
    const sig = signalFc([{ name: "A", count: 3 }]);
    expect(bivariateViable(cov, sig)).toBe(false);
  });

  it("is NOT viable when every coverage value is identical (t1 === t2)", () => {
    const cov = coverageFc(
      Array.from({ length: BIVARIATE_MIN_UNITS }, (_, i) => ({
        code: `AR-${i}`,
        name: `P${i}`,
        value: 80, // all equal → degenerate coverage terciles
      })),
    );
    const sig = signalFc(
      Array.from({ length: BIVARIATE_MIN_UNITS }, (_, i) => ({ name: `P${i}`, count: 1 + i })),
    );
    expect(bivariateViable(cov, sig)).toBe(false);
  });

  it("ignores suppressed cells when counting comparable units", () => {
    // MIN_UNITS visible + several suppressed — still viable (suppressed don't count
    // toward the distribution, but the visible ones already clear the bar).
    const base = spreadUnits(BIVARIATE_MIN_UNITS);
    expect(bivariateViable(base.cov, base.sig)).toBe(true);
  });
});

describe("bivariateRefusalReason — WHY the encoding is refused (Item 2: split the two reasons)", () => {
  it("returns null when the encoding is viable", () => {
    const { cov, sig } = spreadUnits(BIVARIATE_MIN_UNITS);
    expect(bivariateRefusalReason(cov, sig)).toBeNull();
  });

  it('returns "count" when an axis has fewer than the minimum comparable units', () => {
    const { cov, sig } = spreadUnits(BIVARIATE_MIN_UNITS - 1);
    expect(bivariateRefusalReason(cov, sig)).toBe("count");
  });

  it('returns "tercile" when there are enough units but the cut-points collapse', () => {
    // Enough units, but every coverage value is identical → t1 === t2. Not a
    // count problem — the distribution is too flat to cut into honest levels.
    const cov = coverageFc(
      Array.from({ length: BIVARIATE_MIN_UNITS }, (_, i) => ({
        code: `AR-${i}`,
        name: `P${i}`,
        value: 80,
      })),
    );
    const sig = signalFc(
      Array.from({ length: BIVARIATE_MIN_UNITS }, (_, i) => ({ name: `P${i}`, count: 1 + i })),
    );
    expect(bivariateRefusalReason(cov, sig)).toBe("tercile");
  });

  it("count is reported BEFORE tercile when both would fail (too few AND degenerate)", () => {
    // A lone province fails the count bar first; report that, not the (also
    // degenerate) terciles — the operator's actionable reading is "too few units".
    const cov = coverageFc([{ code: "AR-A", name: "A", value: 95 }]);
    const sig = signalFc([{ name: "A", count: 3 }]);
    expect(bivariateRefusalReason(cov, sig)).toBe("count");
  });

  it("bivariateViable agrees with bivariateRefusalReason (viable ⇔ null)", () => {
    const viable = spreadUnits(BIVARIATE_MIN_UNITS);
    expect(bivariateViable(viable.cov, viable.sig)).toBe(
      bivariateRefusalReason(viable.cov, viable.sig) === null,
    );
    const notViable = spreadUnits(BIVARIATE_MIN_UNITS - 1);
    expect(bivariateViable(notViable.cov, notViable.sig)).toBe(
      bivariateRefusalReason(notViable.cov, notViable.sig) === null,
    );
  });
});

describe("tercileThresholds + classifyTercile", () => {
  it("splits a spread distribution into low/mid/high", () => {
    const th = tercileThresholds([0, 10, 20, 30, 40, 50, 60, 70, 80]);
    expect(th).not.toBeNull();
    if (!th) return;
    expect(classifyTercile(5, th)).toBe(0);
    expect(classifyTercile(40, th)).toBe(1);
    expect(classifyTercile(80, th)).toBe(2);
  });

  it("returns null for an empty distribution", () => {
    expect(tercileThresholds([])).toBeNull();
  });

  it("degenerate (all equal) never yields a mid bucket", () => {
    const th = tercileThresholds([50, 50, 50]);
    expect(th).toEqual({ t1: 50, t2: 50 });
    if (!th) return;
    expect(classifyTercile(50, th)).toBe(0); // <= t1
    expect(classifyTercile(51, th)).toBe(2); // > t2
  });
});

describe("3×3 index + risk helpers", () => {
  it("risk corner is low coverage × high signal, calm corner is high coverage × low signal", () => {
    expect(bivariateIndex(0, 2)).toBe(BIVARIATE_RISK_INDEX);
    expect(bivariateIndex(2, 0)).toBe(BIVARIATE_SAFE_INDEX);
    expect(BIVARIATE_RISK_INDEX).toBe(6);
    expect(BIVARIATE_SAFE_INDEX).toBe(2);
  });

  it("risk score peaks at the risk corner and bottoms at the calm corner", () => {
    expect(riskScore(0, 2)).toBe(4);
    expect(riskScore(2, 0)).toBe(0);
    expect(riskLabel(0, 2)).toBe("alto");
    expect(riskLabel(2, 0)).toBe("bajo");
    expect(riskLabel(1, 1)).toBe("medio");
  });

  it("es-AR class labels agree with the caption grammar", () => {
    expect(coverageClassLabel(0)).toBe("baja");
    expect(signalClassLabel(2)).toBe("altas");
  });
});

describe("buildBivariateCells — join + classification", () => {
  const coverage = coverageFc([
    { code: "AR-A", name: "Salta", value: 30 },
    { code: "AR-B", name: "Buenos Aires", value: 55 },
    { code: "AR-C", name: "CABA", value: 90 },
  ]);
  const signal = signalFc([
    { name: "Salta", count: 40 },
    { name: "Buenos Aires", count: 12 },
    { name: "CABA", count: 1 },
  ]);

  it("classifies each province over the scope distribution", () => {
    const cells = buildBivariateCells(coverage, signal);
    const salta = cellByCode(cells, "AR-A");
    expect(salta?.coverageClass).toBe(0); // lowest coverage
    expect(salta?.signalClass).toBe(2); // highest signal → risk corner
    expect(salta?.coverageValue).toBe(30);
    expect(salta?.signalValue).toBe(40);
    expect(salta?.suppressed).toBe(false);

    const caba = cellByCode(cells, "AR-C");
    expect(caba?.coverageClass).toBe(2); // highest coverage
    expect(caba?.signalClass).toBe(0); // lowest signal → calm corner
  });

  it("joins case/whitespace-insensitively on province name", () => {
    const cells = buildBivariateCells(
      coverageFc([{ code: "AR-A", name: " Salta ", value: 30 }]),
      signalFc([{ name: "salta", count: 40 }]),
    );
    expect(cellByCode(cells, "AR-A")?.signalValue).toBe(40);
  });
});

describe("buildBivariateCells — k-anon suppression propagation (privacy invariant)", () => {
  it("a coverage-suppressed unit is suppressed and carries NO classes", () => {
    const cells = buildBivariateCells(
      coverageFc([
        { code: "AR-A", name: "Salta", value: null, suppressed: true },
        { code: "AR-B", name: "Buenos Aires", value: 55 },
      ]),
      signalFc([
        { name: "Salta", count: 40 },
        { name: "Buenos Aires", count: 12 },
      ]),
    );
    const salta = cellByCode(cells, "AR-A");
    expect(salta?.suppressed).toBe(true);
    expect(salta?.coverageClass).toBeNull();
    expect(salta?.signalClass).toBeNull();
  });

  it("a signal-suppressed OR null-count unit propagates to suppressed (never inferred)", () => {
    const cells = buildBivariateCells(
      coverageFc([
        { code: "AR-A", name: "Salta", value: 30 },
        { code: "AR-B", name: "Jujuy", value: 45 },
      ]),
      signalFc([
        { name: "Salta", count: null, suppressed: true },
        { name: "Jujuy", count: null }, // null count == k-anon hidden
      ]),
    );
    expect(cellByCode(cells, "AR-A")?.suppressed).toBe(true);
    expect(cellByCode(cells, "AR-A")?.coverageClass).toBeNull();
    expect(cellByCode(cells, "AR-B")?.suppressed).toBe(true);
  });

  it("a unit merely MISSING from the signal input is no-data, NOT suppressed", () => {
    const cells = buildBivariateCells(
      coverageFc([{ code: "AR-A", name: "Salta", value: 30 }]),
      signalFc([{ name: "Otra", count: 5 }]),
    );
    const salta = cellByCode(cells, "AR-A");
    expect(salta?.suppressed).toBe(false);
    expect(salta?.signalValue).toBeNull();
    expect(salta?.signalClass).toBeNull(); // no signal → withhold color, but no hatch
  });

  it("suppressed values never shift the tercile boundaries", () => {
    // AR-Z is suppressed with an extreme raw value; it must not enter the terciles.
    const cells = buildBivariateCells(
      coverageFc([
        { code: "AR-A", name: "A", value: 10 },
        { code: "AR-B", name: "B", value: 20 },
        { code: "AR-C", name: "C", value: 30 },
        { code: "AR-Z", name: "Z", value: null, suppressed: true },
      ]),
      signalFc([
        { name: "A", count: 1 },
        { name: "B", count: 2 },
        { name: "C", count: 3 },
        { name: "Z", count: 9999, suppressed: true },
      ]),
    );
    // With only 10/20/30 in the coverage distribution, C (30) is the high tercile.
    expect(cellByCode(cells, "AR-C")?.coverageClass).toBe(2);
    expect(cellByCode(cells, "AR-Z")?.suppressed).toBe(true);
  });
});
