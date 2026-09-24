// THE SUPPRESSION PARTITION IS NOT THE SERVED SURFACE — the rule this file pins.
//
// `complementarySuppress` (lib/metrics/anonymity.ts) guarantees a property of the
// PARTITION it returns: after the pass a province group holds 0 or ≥2 suppressed
// cells, so no lone hidden cell is recoverable by subtraction. The map is NOT
// served that partition. `buildChoroplethFeatures` drops every cell whose centroid
// is null — `pointFeature` returns `geometry: null` for a missing coordinate and
// the builder filters those out, because a cell with no coordinate can neither
// fill a division polygon nor plot a dot.
//
// The dropped cells are precisely the ones most likely to BE the primary
// suppression. A pets locality whose name matches no ar_localities row resolves
// NEITHER a department code NOR a centroid, so the department fold keeps it as
// its own `loc:` bucket (deliberately — "its pets are neither dropped nor
// mis-attributed") with null coordinates, and such buckets are small by nature.
//
// Measured shape, from the panorama seed (microchip, department grain, San Luis):
// `Barrio 270 Viviendas` has 3 chipped pets and no ar_localities row at all, so it
// is the group's ONE primary; complementary suppression therefore promotes the
// smallest visible sibling, department 74049 (Junín, 9). Both are suppressed in
// the partition — and only 74049 reaches the FeatureCollection. A census taken off
// the served features reads "one suppressed cell in San Luis, with visible
// siblings", i.e. reports a differencing hole that does not exist, and would just
// as happily miss a real one.
//
// This cost the cube-parity suite a false failure (its complementary-footprint
// guard counted suppressed cells off the rendered features). The fix was to census
// the cube ROWS. These cases pin WHY, without a database.

import { describe, expect, it } from "vitest";

import { complementarySuppress, suppressSmallCells } from "@/lib/metrics";
import {
  type ChoroplethCell,
  type DepartmentRollupRow,
  aggregateCellsToDepartment,
  buildChoroplethFeatures,
} from "@/src/modules/panorama/application/build-features";

const PROVINCE = "San Luis";

function locality(p: Partial<DepartmentRollupRow>): DepartmentRollupRow {
  return {
    key: `${PROVINCE}|${p.locality ?? "Loc"}`,
    province: PROVINCE,
    locality: "Loc",
    // Raw locality centroids from ar_localities. The department fold prefers the
    // department's precomputed representative point whenever a departmentCode
    // resolved, so these only matter for the unmatched `loc:` bucket — where they
    // are null, which is the whole point of the fixture.
    centroidLat: null,
    centroidLng: null,
    departmentCode: null,
    departmentName: null,
    count: 1,
    ...p,
  };
}

/**
 * The exact chain `toChoroplethCells` (repository-choropleth.ts) runs after the
 * department fold: primary k-anon, then the complementary pass grouped by
 * province, then cells that carry the value only when visible.
 */
function partitionCells(rollup: readonly DepartmentRollupRow[]): ChoroplethCell[] {
  const primary = suppressSmallCells([...rollup], {
    count: (r) => r.count,
    key: (r) => r.key,
  });
  const { visible, suppressed } = complementarySuppress(
    primary.visible as unknown as readonly DepartmentRollupRow[],
    primary.suppressed,
    { group: (r) => r.province, count: (r) => r.count },
  );
  return [...visible.map((r) => toCell(r, false)), ...suppressed.map((r) => toCell(r, true))];
}

function toCell(r: DepartmentRollupRow, suppressed: boolean): ChoroplethCell {
  return {
    key: r.key,
    province: r.province,
    locality: r.locality,
    centroidLat: r.centroidLat,
    centroidLng: r.centroidLng,
    departmentCode: r.departmentCode ?? null,
    departmentName: r.departmentName ?? null,
    value: suppressed ? null : r.count,
    suppressed,
  };
}

/** The San Luis microchip shape, verbatim from the seed. */
function sanLuisRollup(): DepartmentRollupRow[] {
  return aggregateCellsToDepartment([
    // No ar_localities row → no department code AND no centroid. 3 < k=5.
    locality({ locality: "Barrio 270 Viviendas", count: 3 }),
    locality({
      locality: "Santa Rosa del Conlara",
      departmentCode: "74049",
      departmentName: "Junín",
      count: 9,
    }),
    locality({
      locality: "Candelaria",
      departmentCode: "74007",
      departmentName: "Ayacucho",
      count: 14,
    }),
    locality({
      locality: "Nogolí",
      departmentCode: "74014",
      departmentName: "Belgrano",
      count: 15,
    }),
    locality({
      locality: "San Luis",
      departmentCode: "74056",
      departmentName: "Juan Martín de Pueyrredón",
      count: 92,
    }),
  ]);
}

const suppressedKeys = (cells: readonly ChoroplethCell[]): string[] =>
  cells
    .filter((c) => c.suppressed)
    .map((c) => c.key)
    .sort();

describe("an unlocatable locality bucket is a real primary suppression", () => {
  it("triggers the complementary promotion of the smallest visible department", () => {
    const cells = partitionCells(sanLuisRollup());

    // The unmatched locality keeps its own `loc:` bucket in the fold …
    const orphan = cells.find((c) => c.key === `${PROVINCE}|loc:Barrio 270 Viviendas`);
    expect(orphan, "the fold must keep the unmatched locality as its own bucket").toBeDefined();
    expect(orphan?.centroidLat).toBeNull();
    expect(orphan?.centroidLng).toBeNull();

    // … it is the group's ONE primary (3 < k=5), so the pass also promotes the
    // smallest visible sibling — 74049 at 9, not 74007 at 14.
    expect(suppressedKeys(cells)).toEqual([
      `${PROVINCE}|dept:74049`,
      `${PROVINCE}|loc:Barrio 270 Viviendas`,
    ]);
    // The partition therefore satisfies complementarySuppress's post-condition.
    expect(suppressedKeys(cells)).toHaveLength(2);
  });
});

describe("the served FeatureCollection is a lossy projection of that partition", () => {
  it("drops the coordinate-less primary, so a features census undercounts the group", () => {
    const cells = partitionCells(sanLuisRollup());
    const features = buildChoroplethFeatures(cells).features;

    // Every department cell renders (the fold resolved a representative point for
    // each code); the coordinate-less `loc:` bucket does not.
    expect(features).toHaveLength(cells.length - 1);
    expect(
      features.some((f) => f.properties.locality === "Barrio 270 Viviendas"),
      "a cell with no centroid cannot be rendered and must not appear",
    ).toBe(false);

    // THE RULE: counting suppressed cells off the features reports 1 where the
    // partition holds 2. That gap is not noise — it is a group that looks like a
    // differencing hole and is not one (and, symmetrically, a real hole this
    // population could hide). Census the partition, never the surface.
    const suppressedInFeatures = features.filter((f) => f.properties.suppressed).length;
    expect(suppressedInFeatures).toBe(1);
    expect(suppressedKeys(cells)).toHaveLength(2);
    expect(suppressedInFeatures).toBeLessThan(suppressedKeys(cells).length);
  });

  it("still withholds every suppressed value it does render", () => {
    const features = buildChoroplethFeatures(partitionCells(sanLuisRollup())).features;
    for (const f of features) {
      if (f.properties.suppressed) expect(f.properties.value).toBeNull();
      else expect(typeof f.properties.value).toBe("number");
    }
  });
});
