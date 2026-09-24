// Unit tests for the pure detail-tier department fold (PO "Option A").
//
// aggregateCellsToDepartment folds a per-(province, locality) rollup up to the
// administrative DIVISION the map draws: the departamento/partido everywhere, the
// barrio in CABA. Verified WITHOUT a database — it is a pure fold.

import { describe, expect, it } from "vitest";

import { suppressSmallCells } from "@/lib/metrics";
import {
  type DepartmentRollupRow,
  aggregateCellsToDepartment,
} from "@/src/modules/panorama/application/build-features";
import { DEPARTMENT_REPRESENTATIVE_POINTS } from "@/src/modules/panorama/domain/geo-representative-points";

function row(p: Partial<DepartmentRollupRow>): DepartmentRollupRow {
  return {
    key: "k",
    province: "Buenos Aires",
    locality: "Loc",
    centroidLat: null,
    centroidLng: null,
    departmentCode: null,
    departmentName: null,
    count: 1,
    ...p,
  };
}

describe("aggregateCellsToDepartment", () => {
  it("sums localities that share a department into one cell that clears k=5", () => {
    // Three localities, each below k=5, all in INDEC department 06035. At locality
    // granularity every cell would be suppressed; folded to the department the
    // total is 9 (>= 5) → a single visible cell.
    const out = aggregateCellsToDepartment([
      row({ locality: "A", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 3 }),
      row({ locality: "B", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 3 }),
      row({ locality: "C", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(9);
    expect(out[0].departmentCode).toBe("06035");
    expect(out[0].departmentName).toBe("Adolfo Alsina");
    // The unit label becomes the department name (for the popup).
    expect(out[0].locality).toBe("Adolfo Alsina");
  });

  it("keeps CABA at the barrio (no department) — locality label preserved, code null", () => {
    const out = aggregateCellsToDepartment([
      row({ province: "CABA", locality: "Palermo", departmentCode: null, count: 7 }),
      row({ province: "CABA", locality: "Caballito", departmentCode: null, count: 2 }),
    ]);
    expect(out).toHaveLength(2);
    const palermo = out.find((r) => r.locality === "Palermo");
    expect(palermo?.count).toBe(7);
    expect(palermo?.departmentCode).toBeNull();
  });

  it("a locality with no resolved department keeps its own bucket (province total preserved)", () => {
    const out = aggregateCellsToDepartment([
      row({ locality: "Matched", departmentCode: "06035", departmentName: "Dept", count: 6 }),
      row({ locality: "Orphan", departmentCode: null, departmentName: null, count: 4 }),
    ]);
    // Two distinct buckets — the orphan is not merged into the department, so the
    // province total (10) is fully accounted for (6 + 4), never dropped.
    expect(out).toHaveLength(2);
    expect(out.reduce((s, r) => s + r.count, 0)).toBe(10);
    const orphan = out.find((r) => r.locality === "Orphan");
    expect(orphan?.count).toBe(4);
    expect(orphan?.departmentCode).toBeNull();
  });

  it("falls back to averaging constituent locality centroids when the department has no precomputed representative point", () => {
    // "99998" is not a real INDEC code (not in DEPARTMENT_REPRESENTATIVE_POINTS),
    // so the fold must fall back to the old unweighted-average behavior.
    expect(DEPARTMENT_REPRESENTATIVE_POINTS["99998"]).toBeUndefined();
    const out = aggregateCellsToDepartment([
      row({
        locality: "A",
        departmentCode: "99998",
        centroidLat: "-37.0",
        centroidLng: "-63.0",
        count: 3,
      }),
      row({
        locality: "B",
        departmentCode: "99998",
        centroidLat: "-38.0",
        centroidLng: "-65.0",
        count: 3,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(Number(out[0].centroidLat)).toBeCloseTo(-37.5, 6);
    expect(Number(out[0].centroidLng)).toBeCloseTo(-64.0, 6);
  });

  it("emits a null centroid when no constituent locality had one AND the department has no precomputed point", () => {
    const out = aggregateCellsToDepartment([
      row({
        locality: "A",
        departmentCode: "99998",
        centroidLat: null,
        centroidLng: null,
        count: 6,
      }),
    ]);
    expect(out[0].centroidLat).toBeNull();
    expect(out[0].centroidLng).toBeNull();
  });

  it("point-on-surface fix: uses the department's PRECOMPUTED representative point over the naive locality-centroid average (Tierra del Fuego / Ushuaia, INDEC 94015)", () => {
    // Simulate locality rows whose average would drift far from Isla Grande
    // (e.g. toward the Malvinas/Georgias claim, the exact "centroid in the
    // water" failure mode this fix closes) — the fold must IGNORE that average
    // for a real department code and use the precomputed point instead.
    const naiveDriftedRows = [
      row({
        locality: "Ushuaia",
        departmentCode: "94015",
        departmentName: "Ushuaia",
        centroidLat: "-54.8",
        centroidLng: "-68.3",
        count: 3,
      }),
      row({
        locality: "Puerto remoto (simulado)",
        departmentCode: "94015",
        departmentName: "Ushuaia",
        centroidLat: "-51.8",
        centroidLng: "-59.0",
        count: 3,
      }),
    ];
    const out = aggregateCellsToDepartment(naiveDriftedRows);
    expect(out).toHaveLength(1);

    const naiveAvgLat = -(54.8 + 51.8) / 2;
    const naiveAvgLng = -(68.3 + 59.0) / 2;
    const rep = DEPARTMENT_REPRESENTATIVE_POINTS["94015"];
    expect(rep).toBeDefined();

    // Matches the precomputed value exactly...
    expect(Number(out[0].centroidLat)).toBeCloseTo(rep.lat, 5);
    expect(Number(out[0].centroidLng)).toBeCloseTo(rep.lng, 5);
    // ...and differs materially from the naive average of the input rows (the
    // bug this fix closes — the naive mean is >1 degree away from the real point).
    expect(Math.abs(Number(out[0].centroidLat) - naiveAvgLat)).toBeGreaterThan(1);
    expect(Math.abs(Number(out[0].centroidLng) - naiveAvgLng)).toBeGreaterThan(1);
  });

  it("does not merge the same department code ACROSS different provinces", () => {
    // A homonymous department code should never merge Buenos Aires with Córdoba —
    // the fold keys on (province, unit).
    const out = aggregateCellsToDepartment([
      row({ province: "Buenos Aires", departmentCode: "99999", count: 6 }),
      row({ province: "Córdoba", departmentCode: "99999", count: 6 }),
    ]);
    expect(out).toHaveLength(2);
  });
});

// The aggregated POINT loaders (perdidas/mordeduras/denuncias/zoonosis/sintomas)
// run the SAME pipeline the choropleth loaders do: aggregateCellsToDepartment →
// suppressSmallCells(k=5). These tests pin the composition end-to-end (the fold
// is what turns near-total locality-tier suppression into a readable department
// map) without a database — suppressSmallCells is the exact k-anon primitive the
// repository's toAggregatedCells calls.
// ---------------------------------------------------------------------------
// SECURITY: the fold is a REGROUPING, never a WIDENING.
//
// A govt operator is scoped to LOCALITIES; the map draws DEPARTMENTS. It is
// tempting to close that gap by aggregating at the department grain in SQL so a
// municipal operator's sparse map fills in. That would be an AUTHORIZATION
// change, not a rendering fix: measured on the local seed, a Santa Cruz /
// El Calafate operator is assigned 11 pets in 1 locality; their department
// (78028 Lago Argentino) holds 33 pets across 3 localities and the province
// holds 394 across 28. Filling the map that way shows an operator pets they
// were never granted.
//
// The fold is safe precisely because it is PURE and CLOSED over its input: the
// scope clause filters first, and the fold only regroups rows that already
// survived it. These tests pin that closure so a future "resolve up to a grain
// that has data" cannot be implemented by widening the fold.
// ---------------------------------------------------------------------------
describe("aggregateCellsToDepartment — non-widening invariant", () => {
  it("conserves the total count (no pet is invented, none is dropped)", () => {
    const input = [
      row({
        // Explicit — the header above tells a Santa Cruz / El Calafate story and
        // this fixture inherited row()'s "Buenos Aires" default, so the data
        // contradicted the prose that justifies it. The sibling test below
        // already spells Santa Cruz out.
        province: "Santa Cruz",
        locality: "El Calafate",
        departmentCode: "78028",
        departmentName: "Lago Argentino",
        count: 11,
      }),
      row({ province: "CABA", locality: "Palermo", count: 206 }),
      row({
        province: "Tierra del Fuego",
        locality: "Ushuaia",
        departmentCode: "94015",
        departmentName: "Ushuaia",
        count: 50,
      }),
    ];
    const total = input.reduce((n, r) => n + r.count, 0);
    const out = aggregateCellsToDepartment(input);
    expect(out.reduce((n, r) => n + r.count, 0)).toBe(total);
    // The sum alone does not press the invariant: collapsing all three provinces
    // into ONE national blob conserves it perfectly (H8.2). Pin the DISTRIBUTION
    // too — the sum is only meaningful alongside where the counts landed.
    expect(Object.fromEntries(out.map((r) => [`${r.province}/${r.locality}`, r.count]))).toEqual({
      "Santa Cruz/Lago Argentino": 11,
      "CABA/Palermo": 206,
      "Tierra del Fuego/Ushuaia": 50,
    });
  });

  it("never emits a unit that no input row contributed to", () => {
    // The operator is assigned ONE locality of department 78028. The fold must
    // emit that department carrying ONLY the assigned locality's count — it has
    // no way to reach the department's other localities, and must not acquire
    // one. A cell of 11 (not 33) is the correct, scoped answer.
    const out = aggregateCellsToDepartment([
      row({
        locality: "El Calafate",
        departmentCode: "78028",
        departmentName: "Lago Argentino",
        count: 11,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].departmentCode).toBe("78028");
    expect(out[0].count).toBe(11);
  });

  it("groups ONLY co-departmental input rows — disjoint scopes stay disjoint", () => {
    // A 3-locality operator whose localities sit in three different units gets
    // three cells, never one merged national blob.
    const out = aggregateCellsToDepartment([
      row({
        province: "Santa Cruz",
        locality: "El Calafate",
        departmentCode: "78028",
        departmentName: "Lago Argentino",
        count: 11,
      }),
      row({ province: "CABA", locality: "Palermo", count: 206 }),
      row({
        province: "Tierra del Fuego",
        locality: "Ushuaia",
        departmentCode: "94015",
        departmentName: "Ushuaia",
        count: 50,
      }),
    ]);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.province))).toEqual(
      new Set(["Santa Cruz", "CABA", "Tierra del Fuego"]),
    );
    // Three cells with the right province labels would also survive a fold that
    // SWAPPED their counts (H8.2: "nunca afirma los counts por celda"). Pin each
    // cell to its own number so a misattribution cannot pass as a disjointness.
    expect(Object.fromEntries(out.map((r) => [r.province, r.count]))).toEqual({
      "Santa Cruz": 11,
      CABA: 206,
      "Tierra del Fuego": 50,
    });
  });

  // The fixture H8.2 found missing: a department the operator was NOT granted,
  // asserted absent. Everything else in this describe presses what the fold DOES
  // with its input; nothing pressed what it must never ADD.
  //
  // This is not hypothetical symmetry. The sibling fold in
  // lib/analytics/subregion-aggregate.ts (aggregateRowsByDepartment) returns the
  // FULL department set for a province by design — every department present with
  // an honest zero, because /gob/perdidas draws a complete choropleth. If someone
  // ever "unified" the two, a govt operator scoped to one locality would receive
  // a cell for every department in the country. The fold's safety rests entirely
  // on being CLOSED over its input, so closure is what gets asserted.
  it("never emits a department absent from the input — the out-of-grant cell must not appear", () => {
    // The operator holds ONE locality in department 78028. 94015 (Ushuaia) is a
    // real department in DEPARTMENT_REPRESENTATIVE_POINTS that they were not
    // granted; a widening fold that reached for "any grain with a known point"
    // would surface it.
    expect(DEPARTMENT_REPRESENTATIVE_POINTS["94015"]).toBeDefined();
    expect(DEPARTMENT_REPRESENTATIVE_POINTS["78028"]).toBeDefined();

    const out = aggregateCellsToDepartment([
      row({
        province: "Santa Cruz",
        locality: "El Calafate",
        departmentCode: "78028",
        departmentName: "Lago Argentino",
        count: 11,
      }),
    ]);

    const emitted = out.map((r) => r.departmentCode);
    expect(emitted).toEqual(["78028"]);
    expect(emitted).not.toContain("94015");
    // And the granted department carries only the granted locality's count —
    // 11, not the 33 the whole department holds on the local seed.
    expect(out.map((r) => r.count)).toEqual([11]);
  });

  it("emits no cell for a department whose only input row belongs to another province", () => {
    // Two rows, two provinces, two departments. Neither may borrow the other's
    // unit: a fold that keyed on department code ALONE would be correct here by
    // luck, so the codes are distinct AND the provinces are asserted per cell.
    const out = aggregateCellsToDepartment([
      row({
        province: "Santa Cruz",
        locality: "El Calafate",
        departmentCode: "78028",
        departmentName: "Lago Argentino",
        count: 11,
      }),
      row({
        province: "Tierra del Fuego",
        locality: "Ushuaia",
        departmentCode: "94015",
        departmentName: "Ushuaia",
        count: 50,
      }),
    ]);
    expect(
      Object.fromEntries(out.map((r) => [r.departmentCode, `${r.province}:${r.count}`])),
    ).toEqual({
      "78028": "Santa Cruz:11",
      "94015": "Tierra del Fuego:50",
    });
  });

  it("an empty scope folds to nothing — never to a province-wide fallback", () => {
    // The honest answer for a scope with no rows is NO cells. Substituting a
    // coarser unit here is the widening this suite exists to prevent.
    expect(aggregateCellsToDepartment([])).toEqual([]);
  });
});

describe("department fold + k-anon (aggregated point loader pipeline)", () => {
  it("makes a department VISIBLE whose member localities are each below k=5 but sum to >= 5", () => {
    const folded = aggregateCellsToDepartment([
      row({ locality: "A", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 2 }),
      row({ locality: "B", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 2 }),
      row({ locality: "C", departmentCode: "06035", departmentName: "Adolfo Alsina", count: 2 }),
    ]);
    const { visible, suppressed, suppressedCount } = suppressSmallCells(folded, {
      count: (r) => r.count,
      key: (r) => r.key,
    });
    // At locality granularity all three cells (count 2) are suppressed; folded to
    // the department the total is 6 (>= 5) → exactly one visible cell, zero suppressed.
    expect(suppressedCount).toBe(0);
    expect(suppressed).toHaveLength(0);
    expect(visible).toHaveLength(1);
    expect((visible[0] as DepartmentRollupRow).count).toBe(6);
    expect((visible[0] as DepartmentRollupRow).locality).toBe("Adolfo Alsina");
  });

  it("keeps a CABA barrio below k=5 suppressed (barrio path unchanged, never merged)", () => {
    const folded = aggregateCellsToDepartment([
      row({ province: "CABA", locality: "Palermo", departmentCode: null, count: 3 }),
    ]);
    const { visible, suppressedCount } = suppressSmallCells(folded, {
      count: (r) => r.count,
      key: (r) => r.key,
    });
    // The barrio is the unit in CABA — a below-k barrio stays suppressed (the fold
    // never merges barrios into a department, so the privacy floor is unchanged).
    expect(suppressedCount).toBe(1);
    expect(visible).toHaveLength(0);
  });
});

// L1·2 of the locality plan (2026-09-08): hurt cases for the PANORAMA fold,
// written by hand — not a parity test against the /gob fold (see the matching
// block in lib/analytics/subregion-aggregate.test.ts for why parity would lie).
describe("aggregateCellsToDepartment — hurt cases (L1·2)", () => {
  // KNOWN DIVERGENCE, pinned on purpose (L2·2 of the plan is still open). This
  // fold keys a CABA barrio by the RAW locality string, while the /gob fold
  // keys it by normalizeBarioCode — so three "Núñez" and three "Nunez" are ONE
  // visible barrio of 6 on /gob and TWO hidden cells of 3 here. When L2·2 makes
  // this fold normalize, this test goes red: the red is the checkpoint that the
  // divergence closed, and it must be rewritten to assert a single unit of 6.
  it("KNOWN DIVERGENCE (L2·2 open): Núñez and Nunez are two barrio units in this fold", () => {
    const out = aggregateCellsToDepartment([
      row({ province: "CABA", locality: "Núñez", count: 3 }),
      row({ province: "CABA", locality: "Nunez", count: 3 }),
    ]);
    expect(out.map((c) => c.key).sort()).toEqual(["CABA|barrio:Nunez", "CABA|barrio:Núñez"]);
    expect(out.map((c) => c.count)).toEqual([3, 3]);
  });

  it("a locality OUTSIDE the catalog (no department) keeps its own unit — it is not dropped or merged", () => {
    const out = aggregateCellsToDepartment([
      row({ locality: "Narnia", departmentCode: null, departmentName: null, count: 7 }),
      row({
        locality: "25 de Mayo",
        departmentCode: "06854",
        departmentName: "25 de Mayo",
        count: 6,
      }),
    ]);
    expect(out).toHaveLength(2);
    const narnia = out.find((c) => c.key === "Buenos Aires|loc:Narnia");
    expect(narnia).toMatchObject({ count: 7, departmentCode: null });
    expect(out.reduce((s, c) => s + c.count, 0)).toBe(13);
  });
});
