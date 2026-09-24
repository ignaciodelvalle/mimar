// Unit tests for lib/open-data/province-suppression.ts — pure, no DB.

import { describe, expect, it } from "vitest";

import {
  type DensityRow,
  OPEN_DATA_K,
  type RateRow,
  isRateCellProtected,
  suppressDensityProvinces,
  suppressRateProvinces,
} from "../province-suppression";

const density = (provinceCode: string, count: number): DensityRow => ({
  provinceCode,
  provinceName: provinceCode,
  count,
});

const rate = (provinceCode: string, numerator: number, denominator: number): RateRow => ({
  provinceCode,
  provinceName: provinceCode,
  numerator,
  denominator,
  ratePct: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0,
});

const suppressedCodes = <Row extends { provinceCode: string }>(
  tagged: { row: Row; suppressed: boolean }[],
): string[] =>
  tagged
    .filter((t) => t.suppressed)
    .map((t) => t.row.provinceCode)
    .sort();

describe("k threshold", () => {
  it("defaults to 5", () => {
    expect(OPEN_DATA_K).toBe(5);
  });
});

describe("suppressDensityProvinces", () => {
  it("suppresses a sub-k province count", () => {
    // AR-A has 3 (< 5) → suppressed by the primary k=5 rule. (Because that makes
    // it the LONE national suppression, complementary suppression additionally
    // hides a sibling — asserted precisely in the dedicated case below; here we
    // only assert the sub-k cell itself is suppressed.)
    const tagged = suppressDensityProvinces([
      density("AR-A", 3),
      density("AR-B", 40),
      density("AR-C", 55),
    ]);
    expect(suppressedCodes(tagged)).toContain("AR-A");
  });

  it("does NOT touch a dataset where every province clears k", () => {
    const tagged = suppressDensityProvinces([
      density("AR-A", 5),
      density("AR-B", 200),
      density("AR-C", 9000),
    ]);
    expect(suppressedCodes(tagged)).toEqual([]);
    // Values are untouched — the dataset layer publishes them verbatim.
    expect(tagged.every((t) => !t.suppressed)).toBe(true);
  });

  it("applies complementary suppression when exactly one national cell is suppressed", () => {
    // Only AR-A is sub-k. That leaves it as the LONE suppressed cell nationally,
    // recoverable as (national total − visible provinces). Complementary
    // suppression must also hide the next-smallest visible province (AR-B, 10).
    const tagged = suppressDensityProvinces([
      density("AR-A", 3),
      density("AR-B", 10),
      density("AR-C", 500),
      density("AR-D", 900),
    ]);
    expect(suppressedCodes(tagged)).toEqual(["AR-A", "AR-B"]);
  });

  it("does NOT over-suppress when two cells are already suppressed (no lone cell)", () => {
    // Two sub-k cells → the national total only yields their SUM, never either
    // one. No complementary cell is needed.
    const tagged = suppressDensityProvinces([
      density("AR-A", 3),
      density("AR-B", 4),
      density("AR-C", 500),
      density("AR-D", 900),
    ]);
    expect(suppressedCodes(tagged)).toEqual(["AR-A", "AR-B"]);
  });

  it("suppresses a zero-count province conservatively (count < k)", () => {
    // A 0 exposes no individual, but suppressSmallCells treats count < k
    // uniformly; the density path mirrors the locality tier exactly.
    const tagged = suppressDensityProvinces([
      density("AR-A", 0),
      density("AR-B", 50),
      density("AR-C", 90),
    ]);
    expect(suppressedCodes(tagged)).toContain("AR-A");
  });
});

describe("isRateCellProtected", () => {
  it("protects a sub-k population base", () => {
    expect(isRateCellProtected(2, 4)).toBe(true);
  });

  it("protects a small positive numerator even with a large base", () => {
    expect(isRateCellProtected(2, 9000)).toBe(true);
  });

  it("protects a small complement (denominator − numerator) even with a large base", () => {
    expect(isRateCellProtected(8998, 9000)).toBe(true);
  });

  it("does NOT protect a zero numerator (empty group re-identifies no one)", () => {
    expect(isRateCellProtected(0, 9000)).toBe(false);
  });

  it("does NOT protect a full-coverage cell (zero complement)", () => {
    expect(isRateCellProtected(9000, 9000)).toBe(false);
  });

  it("passes a cell where base, numerator, and complement all clear k", () => {
    expect(isRateCellProtected(4500, 9000)).toBe(false);
  });
});

describe("suppressRateProvinces", () => {
  it("suppresses a province whose numerator is a small positive", () => {
    const tagged = suppressRateProvinces([
      rate("AR-A", 2, 9000), // numerator 2 < 5 → suppressed by the primary rule
      rate("AR-B", 4000, 9000),
      rate("AR-C", 5000, 9000),
    ]);
    // Primary rule catches AR-A; complementary then pulls a sibling (asserted
    // precisely in the dedicated complementary case). Here: AR-A is suppressed.
    expect(suppressedCodes(tagged)).toContain("AR-A");
  });

  it("suppresses a province whose population base is sub-k", () => {
    const tagged = suppressRateProvinces([
      rate("AR-A", 1, 3), // denominator 3 < 5
      rate("AR-B", 4000, 9000),
      rate("AR-C", 5000, 9000),
    ]);
    expect(suppressedCodes(tagged)).toContain("AR-A");
  });

  it("passes a dataset where every province clears every guard", () => {
    const tagged = suppressRateProvinces([
      rate("AR-A", 100, 200),
      rate("AR-B", 4000, 9000),
      rate("AR-C", 5000, 9000),
    ]);
    expect(suppressedCodes(tagged)).toEqual([]);
  });

  it("applies complementary suppression on the numerator when exactly one cell is suppressed", () => {
    // AR-A (numerator 2) is the lone primary suppression. A published national
    // vaccinated total would isolate it → also suppress the smallest-numerator
    // visible sibling (AR-B, numerator 60).
    const tagged = suppressRateProvinces([
      rate("AR-A", 2, 9000),
      rate("AR-B", 60, 9000),
      rate("AR-C", 4000, 9000),
      rate("AR-D", 5000, 9000),
    ]);
    expect(suppressedCodes(tagged)).toEqual(["AR-A", "AR-B"]);
  });

  it("applies complementary suppression when the primary trigger is the COMPLEMENT (denominator − numerator ∈ [1,5))", () => {
    // AR-A: denominator 9000, numerator 8998 → complement = 2 (in [1,5)) is
    // the ONLY protected quantity here (base and numerator both clear k) — the
    // primary suppression fires via isRateCellProtected's complement branch,
    // not the numerator or base branch. It is the lone national suppression,
    // so a published national vaccinated total would still isolate its
    // numerator (8998) by subtracting the visible provinces → complementary
    // suppression must pull in the smallest-numerator visible sibling
    // (AR-B, numerator 60), exactly as it would for a numerator-triggered
    // primary suppression.
    const tagged = suppressRateProvinces([
      rate("AR-A", 8998, 9000),
      rate("AR-B", 60, 9000),
      rate("AR-C", 4000, 9000),
      rate("AR-D", 5000, 9000),
    ]);
    expect(suppressedCodes(tagged)).toEqual(["AR-A", "AR-B"]);
  });
});
