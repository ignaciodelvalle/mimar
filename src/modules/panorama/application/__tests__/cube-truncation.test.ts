// CB1 — cube truncation threading (task #22 companion fix).
//
// Pure, DB-free: the reader used to hardcode `truncated: false`, so a cube-served
// Buenos Aires-scale drill (whose per-province LOCALITY rollup can hit
// PER_LAYER_CAP at build) would claim false completeness and break live-vs-cube
// parity. The builder now captures each province's department-grain `truncated`
// flag in the province row's `den` column (0/1 — reserved-column reuse, see
// buildProvinceCubeRows), and the reader threads it back out.
//
// Also pins the builder read client's timeout resolution (the operational half
// of task #22): long default, env-overridable, garbage-safe.

import { describe, expect, it } from "vitest";

import type { PanoramaCubeRow } from "@/db/schema";
import {
  CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS,
  buildProvinceCubeRows,
  cubeBuilderStatementTimeoutMs,
} from "@/src/modules/panorama/infrastructure/cube-builder";

import { assembleCubeLayerResult } from "../load-layer-features-cube";

// ---------------------------------------------------------------------------
// Row factories — a realistic stored cube shape, override what each case needs.
// ---------------------------------------------------------------------------

function provinceRow(over: Partial<PanoramaCubeRow> = {}): PanoramaCubeRow {
  return {
    metric: "rabies-coverage",
    unitLevel: "province",
    province: "Buenos Aires",
    unitCode: "AR-B",
    label: "Buenos Aires",
    departmentCode: null,
    departmentName: null,
    centroidLat: null,
    centroidLng: null,
    value: "62.1",
    den: 0,
    noLocality: 3,
    suppressed: false,
    complementary: false,
    ...over,
  };
}

function deptRow(over: Partial<PanoramaCubeRow> = {}): PanoramaCubeRow {
  return {
    metric: "rabies-coverage",
    unitLevel: "department",
    province: "Buenos Aires",
    unitCode: "Buenos Aires|dept:06007",
    label: "Adolfo Alsina",
    departmentCode: "06007",
    departmentName: "Adolfo Alsina",
    centroidLat: "-37.1",
    centroidLng: "-62.9",
    value: "12",
    den: null,
    noLocality: null,
    suppressed: false,
    complementary: false,
    ...over,
  };
}

describe("buildProvinceCubeRows — den carries the department-grain truncation flag", () => {
  const cells = [
    { provinceCode: "AR-B", label: "Buenos Aires", value: 62.1, suppressed: false },
    { provinceCode: "AR-L", label: "La Pampa", value: 71, suppressed: false },
  ];
  const residual = new Map([
    ["Buenos Aires", 3],
    ["La Pampa", 0],
  ]);

  it("stores 1 for a province whose locality rollup hit the cap, 0 otherwise", () => {
    const rows = buildProvinceCubeRows(
      "rabies-coverage",
      cells,
      residual,
      new Map([
        ["Buenos Aires", true],
        ["La Pampa", false],
      ]),
    );
    expect(rows.find((r) => r.province === "Buenos Aires")?.den).toBe(1);
    expect(rows.find((r) => r.province === "La Pampa")?.den).toBe(0);
  });

  it("defaults to 0 (complete) for a province absent from the truncation map", () => {
    const rows = buildProvinceCubeRows("rabies-coverage", cells, residual, new Map());
    expect(rows.map((r) => r.den)).toEqual([0, 0]);
  });

  it("keeps the residual and identity fields intact alongside the flag", () => {
    const [ba] = buildProvinceCubeRows(
      "rabies-coverage",
      cells.slice(0, 1),
      residual,
      new Map([["Buenos Aires", true]]),
    );
    expect(ba).toMatchObject({
      metric: "rabies-coverage",
      unitLevel: "province",
      unitCode: "AR-B",
      value: "62.1",
      noLocality: 3,
      den: 1,
    });
  });

  // #40 — the cube used to hardcode `suppressed: false` on every province row,
  // under the same dead "provinces are never suppressed" premise. The flag was
  // the ONLY carrier that survives the round-trip: `value` is stored nullable,
  // and the reader coalesced a null to 0, so a protected province came back out
  // of the cube published as a real, confident zero.
  it("round-trips the k-anon flag and NEVER republishes a suppressed cell as 0", () => {
    const rows = buildProvinceCubeRows(
      "rabies-coverage",
      [{ provinceCode: "AR-Z", label: "Santa Cruz", value: null, suppressed: true }],
      new Map(),
      new Map(),
    );
    expect(rows[0].suppressed).toBe(true);
    expect(rows[0].value).toBeNull();

    const back = assembleCubeLayerResult(
      [
        provinceRow({
          unitCode: "AR-Z",
          province: "Santa Cruz",
          label: "Santa Cruz",
          value: null,
          suppressed: true,
        }),
      ],
      "province",
    );
    const props = back.features.features[0].properties as {
      value: number | null;
      suppressed: boolean;
    };
    expect(props.suppressed).toBe(true);
    expect(props.value).toBeNull();
    expect(props.value).not.toBe(0);
  });
});

describe("assembleCubeLayerResult — truncation threads through to the envelope", () => {
  // A whole-province drill threads the province's own build-time den flag.
  const DRILL = "Buenos Aires";

  it("department drill: truncated=true when the in-scope province row carries den=1", () => {
    const result = assembleCubeLayerResult([provinceRow({ den: 1 }), deptRow()], "locality", DRILL);
    expect(result.truncated).toBe(true);
    expect(result.level).toBe("locality");
  });

  it("department drill: truncated=false when den=0 and when den=null (pre-fix rows)", () => {
    expect(
      assembleCubeLayerResult([provinceRow({ den: 0 }), deptRow()], "locality", DRILL).truncated,
    ).toBe(false);
    expect(
      assembleCubeLayerResult([provinceRow({ den: null }), deptRow()], "locality", DRILL).truncated,
    ).toBe(false);
  });

  it("NATIONAL department (no drill): truncated=true when ANY province build hit the cap (den=1)", () => {
    // The cube national+department view is a superset over the LIVE global cap,
    // but the cube itself is built per province — a province whose OWN locality
    // rollup hit PER_LAYER_CAP (den=1) carries undercount department cells. That
    // incompleteness is real at national scope too, so the envelope must report
    // it honestly (union of the per-province den flags), never hardcode false.
    const result = assembleCubeLayerResult([provinceRow({ den: 1 }), deptRow()], "locality");
    expect(result.truncated).toBe(true);
    expect(result.level).toBe("locality");
  });

  it("NATIONAL department (no drill): truncated=false when no province build was capped", () => {
    const result = assembleCubeLayerResult([provinceRow({ den: 0 }), deptRow()], "locality");
    expect(result.truncated).toBe(false);
    expect(result.level).toBe("locality");
  });

  it("department grain: still computes suppressedCount and noLocalityCount", () => {
    const result = assembleCubeLayerResult(
      [
        provinceRow({ den: 1, noLocality: 3 }),
        deptRow(),
        deptRow({ unitCode: "Buenos Aires|dept:06014", suppressed: true, value: null }),
      ],
      "locality",
      DRILL,
    );
    expect(result.suppressedCount).toBe(1);
    expect(result.noLocalityCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("province grain: never truncated (structurally ≤24 rows), even if den=1", () => {
    const result = assembleCubeLayerResult([provinceRow({ den: 1 })], "province");
    expect(result.truncated).toBe(false);
    expect(result.level).toBe("province");
  });

  // PRE-PUSH REVIEW 2026-07-30 — the province branch HARDCODED `suppressedCount: 0`
  // (last survivor of the "provinces are never suppressed" premise #40 retired).
  // Two consequences: the cube disagreed with the live province loaders, breaking
  // the parity contract this suite's integration sibling asserts; and a
  // cube-served, fully-hatched province map disclosed nothing (the notice card
  // bails on 0). The count is now derived from the SAME `suppressed` flags the
  // cells are built from, so it cannot drift from what the map paints.
  const suppressedProvince = (code: string, name: string) =>
    provinceRow({ unitCode: code, province: name, label: name, value: null, suppressed: true });

  it("province grain: counts the suppressed cells instead of reporting a flat 0", () => {
    const result = assembleCubeLayerResult(
      [provinceRow(), suppressedProvince("AR-Z", "Santa Cruz")],
      "province",
    );
    expect(result.suppressedCount).toBe(1);
  });

  it("province grain: an ALL-suppressed map reports every cell (the notice trigger)", () => {
    const result = assembleCubeLayerResult(
      [suppressedProvince("AR-Z", "Santa Cruz"), suppressedProvince("AR-V", "Tierra del Fuego")],
      "province",
    );
    expect(result.suppressedCount).toBe(2);
    expect(
      result.features.features.every(
        (f) => (f.properties as { suppressed?: boolean }).suppressed === true,
      ),
    ).toBe(true);
  });

  it("province grain: still 0 when nothing is suppressed (no false disclosure)", () => {
    expect(
      assembleCubeLayerResult([provinceRow(), provinceRow({ unitCode: "AR-L" })], "province")
        .suppressedCount,
    ).toBe(0);
  });

  // The parity contract in miniature: the cube reader's province count must be
  // the count of hatched cells, which is exactly what the live loaders' shared
  // `countSuppressed` returns for the same cell set. The full DB-backed
  // cube-vs-live assertion lives in cube-parity.test.ts.
  it("province grain: the count equals the hatched-feature count (cube↔live invariant)", () => {
    const rows = [
      provinceRow(),
      suppressedProvince("AR-Z", "Santa Cruz"),
      suppressedProvince("AR-V", "Tierra del Fuego"),
    ];
    const result = assembleCubeLayerResult(rows, "province");
    const hatched = result.features.features.filter(
      (f) => (f.properties as { suppressed?: boolean }).suppressed === true,
    ).length;
    expect(result.suppressedCount).toBe(hatched);
  });
});

describe("cubeBuilderStatementTimeoutMs — the builder read client's long ceiling", () => {
  it("defaults to 120s when the env is unset", () => {
    expect(cubeBuilderStatementTimeoutMs({})).toBe(CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS).toBe(120_000);
  });

  it("honors an explicit override", () => {
    expect(
      cubeBuilderStatementTimeoutMs({
        CUBE_BUILDER_STATEMENT_TIMEOUT_MS: "200000",
      }),
    ).toBe(200_000);
  });

  it("falls back to the default on garbage or non-positive values", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      expect(
        cubeBuilderStatementTimeoutMs({
          CUBE_BUILDER_STATEMENT_TIMEOUT_MS: bad,
        }),
      ).toBe(CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS);
    }
  });
});
