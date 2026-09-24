// Parity test for /gob/vigilancia's province choropleth (revisión de contexto
// fresco previa al push, item 2). `fetchCasesPerProvinceChoropleth`'s pure
// fold step (`foldCasesPerProvince`, lib/analytics/dashboards/surveillance.ts)
// is a hand-kept re-implementation of `aggregateChoroplethData`
// (lib/analytics/choropleth-data.ts) — surveillance.ts cannot import that
// module (see `ProvinceChoroplethCell`'s docblock: it would create a real
// runtime cycle, not just a lint-fence one). This test feeds the SAME
// LocalityCaseCount[] fixture through both and asserts they agree, so the two
// implementations cannot silently drift apart.
//
// Import direction: this test imports both surveillance.ts and
// choropleth-data.ts. surveillance.ts itself must never import
// choropleth-data.ts (that is the cycle being worked around).

import { aggregateChoroplethData } from "@/lib/analytics/choropleth-data";
import {
  type LocalityCaseCount,
  foldCasesPerProvince,
} from "@/lib/analytics/dashboards/surveillance";
import { complementarySuppress, suppressSmallCells } from "@/lib/metrics";
import { describe, expect, it } from "vitest";

/** Feeds the same rows through aggregateChoroplethData the way
 *  fetchCasesPerProvinceChoropleth's raw rows already carry a resolved code +
 *  a per-locality count (province choropleth is a sum-by-code fold). */
function viaAggregateChoroplethData(rows: LocalityCaseCount[]) {
  return aggregateChoroplethData(
    rows,
    (r) => r.code,
    (r) => r.count,
  );
}

describe("province choropleth: foldCasesPerProvince vs aggregateChoroplethData parity", () => {
  it("agree on a plain multi-locality fold (no suppression in play)", () => {
    const rows: LocalityCaseCount[] = [
      { province: "Buenos Aires", locality: "La Plata", code: "AR-B", count: 12 },
      { province: "Buenos Aires", locality: "Mar del Plata", code: "AR-B", count: 8 },
      { province: "Córdoba", locality: "Villa María", code: "AR-X", count: 6 },
    ];

    expect(foldCasesPerProvince(rows)).toEqual(viaAggregateChoroplethData(rows));
  });

  it("agree when a row's code cannot be resolved (dropped by both)", () => {
    const rows: LocalityCaseCount[] = [
      { province: "Buenos Aires", locality: "La Plata", code: "AR-B", count: 12 },
      { province: "Atlántida", locality: "Nowhere", code: "", count: 9 },
    ];

    expect(foldCasesPerProvince(rows)).toEqual(viaAggregateChoroplethData(rows));
  });

  // Complementary suppression: a LONE sub-k province next to a province
  // sitting exactly AT the k floor — so the fold must also suppress that
  // k-sized sibling (the smallest visible one) via differencing, not just the
  // sub-k province itself.
  it("agree on a lone sub-k province next to a k-sized one (complementary suppression)", () => {
    const rows: LocalityCaseCount[] = [
      { province: "Buenos Aires", locality: "La Plata", code: "AR-B", count: 30 },
      { province: "Córdoba", locality: "Villa María", code: "AR-X", count: 5 }, // exactly k
      { province: "Tierra del Fuego", locality: "Ushuaia", code: "AR-V", count: 2 }, // sub-k, lone
    ];

    const fromFold = foldCasesPerProvince(rows);
    const fromShared = viaAggregateChoroplethData(rows);

    expect(fromFold).toEqual(fromShared);

    // Exercise the scenario for real, not just parity: both AR-V (primary,
    // sub-k) and AR-X (complementary, smallest visible sibling) are hidden;
    // AR-B (well above k, not the smallest) stays visible.
    const suppressedCodes = fromFold.filter((c) => c.suppressed).map((c) => c.code);
    expect(suppressedCodes.sort()).toEqual(["AR-V", "AR-X"]);
    expect(fromFold.find((c) => c.code === "AR-B")?.suppressed).toBeUndefined();
  });

  it("returns an empty array for an empty input, in both implementations", () => {
    expect(foldCasesPerProvince([])).toEqual(viaAggregateChoroplethData([]));
    expect(foldCasesPerProvince([])).toEqual([]);
  });
});

// Mutation proof (item 2): dropping the `complementarySuppress` call from
// `foldCasesPerProvince` must turn the k-sized-sibling assertion above red.
// This block re-derives what the fold WOULD return if that call were removed
// (primary suppression only) and proves it disagrees with the real fold on
// the same fixture — i.e. the assertion above is not vacuously true.
describe("foldCasesPerProvince: complementarySuppress is load-bearing", () => {
  it("primary-suppression-only would NOT hide the k-sized sibling (proves the assertion has teeth)", () => {
    const rows: LocalityCaseCount[] = [
      { province: "Buenos Aires", locality: "La Plata", code: "AR-B", count: 30 },
      { province: "Córdoba", locality: "Villa María", code: "AR-X", count: 5 },
      { province: "Tierra del Fuego", locality: "Ushuaia", code: "AR-V", count: 2 },
    ];

    const cells = [
      { code: "AR-B", value: 30 },
      { code: "AR-X", value: 5 },
      { code: "AR-V", value: 2 },
    ];
    const { visible, suppressed } = suppressSmallCells(cells, {
      count: (c) => c.value,
      key: (c) => c.code,
    });
    // Primary-only: no complementarySuppress call.
    const primaryOnlySuppressedCodes = new Set(suppressed.map((c) => c.code));
    expect(primaryOnlySuppressedCodes).toEqual(new Set(["AR-V"]));
    expect(visible.map((c) => c.code).sort()).toEqual(["AR-B", "AR-X"]);

    // The real fold (with complementarySuppress) hides AR-X too — different
    // from the primary-only result computed above, which is exactly what
    // would ship if the complementarySuppress call were deleted.
    const realResult = foldCasesPerProvince(rows);
    const realSuppressedCodes = new Set(realResult.filter((c) => c.suppressed).map((c) => c.code));
    expect(realSuppressedCodes).not.toEqual(primaryOnlySuppressedCodes);
    expect(realSuppressedCodes).toEqual(new Set(["AR-V", "AR-X"]));

    // Sanity: complementarySuppress itself, called the same way the fold
    // calls it, reproduces the fold's answer — ties this proof to the real
    // primitive rather than a hand-rolled expectation.
    const { suppressed: allSuppressed } = complementarySuppress(
      visible as unknown as ReadonlyArray<{ code: string; value: number }>,
      suppressed,
      { group: () => "AR", count: (c) => c.value },
    );
    expect(new Set(allSuppressed.map((c) => c.code))).toEqual(realSuppressedCodes);
  });
});
