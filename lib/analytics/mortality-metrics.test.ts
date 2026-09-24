// Unit tests for the pure locality-cell sort helper — qa-triage-2026-07-23
// finding #14: a k-anon rollup bucket ("Santiago del Estero (otras
// localidades)") aggregating many sub-threshold localities hit 1.965 in live
// seed data — the single largest bar in the "Distribución por localidad"
// chart, reading as "the #1 locality" even though it isn't one real place.
// sortLocalityCellsRollupLast demotes it to last regardless of count.

import { describe, expect, it } from "vitest";

import { K_ANON_MIN } from "@/lib/metrics";
import type { Cell } from "@/lib/metrics/types";
import { rollupSuppressedLocalities, sortLocalityCellsRollupLast } from "./mortality-metrics";

// The k-anon rollup is itself a published cell. Live review 2026-07-28 found
// /gob/mortalidad rendering "Tierra del Fuego (otras localidades) — 2" under an
// accessible description that promises sub-5 localities are hidden: the fold of
// ONE suppressed locality is that locality, relabelled.
describe("rollupSuppressedLocalities — the fold obeys k, or it does not publish", () => {
  const cell = (key: string, count: number): Cell =>
    ({ key, count, province: "Tierra del Fuego" }) as Cell;

  it("publishes nothing when the folded total is below k", () => {
    expect(rollupSuppressedLocalities([cell("Tolhuin", 2)])).toBeNull();
  });

  it("publishes nothing when several sub-k localities still sum below k", () => {
    expect(
      rollupSuppressedLocalities([cell("Tolhuin", 2), cell("Laguna Escondida", 2)]),
    ).toBeNull();
  });

  it("publishes the fold once it reaches k, flagged as a rollup", () => {
    const out = rollupSuppressedLocalities([cell("Tolhuin", 3), cell("Laguna Escondida", 2)]);
    expect(out).not.toBeNull();
    expect(out?.count).toBe(5);
    expect(out?.key).toBe("Tierra del Fuego (otras localidades)");
    expect((out as Cell & { isRollup?: boolean })?.isRollup).toBe(true);
  });

  it("is exactly at the k boundary — k−1 hides, k publishes", () => {
    // Pinned against the shared constant, not a literal 5, so a policy change
    // moves both the fence and this test together.
    expect(rollupSuppressedLocalities([cell("A", K_ANON_MIN - 1)])).toBeNull();
    expect(rollupSuppressedLocalities([cell("A", K_ANON_MIN)])?.count).toBe(K_ANON_MIN);
  });

  it("never leaks a member locality's own name into the published label", () => {
    const out = rollupSuppressedLocalities([cell("Tolhuin", 4), cell("Laguna Escondida", 4)]);
    expect(out?.key).not.toContain("Tolhuin");
    expect(out?.key).not.toContain("Laguna Escondida");
  });
});

describe("sortLocalityCellsRollupLast", () => {
  it("moves a large rollup cell to the end, even though it has the highest count", () => {
    const cells = [
      { key: "Palermo", count: 12, isRollup: false },
      { key: "Santiago del Estero (otras localidades)", count: 1965, isRollup: true },
      { key: "Recoleta", count: 8, isRollup: false },
    ];
    const sorted = sortLocalityCellsRollupLast(cells);
    expect(sorted.map((c) => c.key)).toEqual([
      "Palermo",
      "Recoleta",
      "Santiago del Estero (otras localidades)",
    ]);
  });

  it("preserves the relative order of non-rollup cells", () => {
    const cells = [
      { key: "B", count: 5, isRollup: false },
      { key: "A", count: 20, isRollup: false },
    ];
    expect(sortLocalityCellsRollupLast(cells).map((c) => c.key)).toEqual(["B", "A"]);
  });

  it("handles multiple rollup cells (mixed-province scope) — both sort after every real cell", () => {
    const cells = [
      { key: "CABA (otras localidades)", count: 40, isRollup: true },
      { key: "Palermo", count: 12, isRollup: false },
      { key: "Córdoba (otras localidades)", count: 30, isRollup: true },
    ];
    const sorted = sortLocalityCellsRollupLast(cells);
    expect(sorted[0].key).toBe("Palermo");
    expect(sorted.slice(1).every((c) => c.isRollup)).toBe(true);
  });

  it("is a no-op when there is no rollup cell", () => {
    const cells = [
      { key: "Palermo", count: 12, isRollup: false },
      { key: "Recoleta", count: 8, isRollup: false },
    ];
    expect(sortLocalityCellsRollupLast(cells)).toEqual(cells);
  });

  it("treats a missing isRollup field the same as false (real cell)", () => {
    const cells: Array<{ key: string; count: number; isRollup?: boolean }> = [
      { key: "Palermo", count: 12 },
      { key: "X (otras localidades)", count: 99, isRollup: true },
    ];
    expect(sortLocalityCellsRollupLast(cells).map((c) => c.key)).toEqual([
      "Palermo",
      "X (otras localidades)",
    ]);
  });

  it("does not mutate the input array", () => {
    const cells = [
      { key: "Z (otras localidades)", count: 99, isRollup: true },
      { key: "Palermo", count: 12, isRollup: false },
    ];
    const original = [...cells];
    sortLocalityCellsRollupLast(cells);
    expect(cells).toEqual(original);
  });
});
