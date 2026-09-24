// Aggregate cube (migration 0139) — the correctness contract for the TS builder.
//
// Integration test — local Supabase + Postgres. Runs the REAL builder against the
// seed, then asserts:
//   (a) PARITY — for every choropleth metric × {province, department} level, for
//       admin-national AND an admin province drill (La Pampa flagship), the cube
//       reader's LayerFeaturesResult is field-for-field identical to the live
//       getLayerFeatures (features + truncated + suppressedCount + noLocalityCount
//       + level). This is the guard against builder/loader drift.
//   (b) SUB-K INVARIANT — no readable department row carries an unsuppressed
//       0 < value < 5, and no province group has exactly ONE suppressed cell with
//       a visible sibling (the differencing-defense property complementarySuppress
//       must have enforced at build).
//   (c) STALENESS GATE — a non-ok / too-old cube makes the reader return null
//       (caller falls back to live).
//   (d) IDEMPOTENCY — running the builder twice yields the same rows and advances
//       the meta build timestamp.

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, panoramaCube, panoramaCubeMeta, panoramaKpiCube, panoramaKpiCubeMeta } from "@/db";
import type { AnalyticsPeriod, DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { buildProjectionContext } from "@/lib/metrics";
import { fetchNetGrowth } from "@/lib/metrics/population-control";

import type { LayerId } from "../../domain/types";
import type { AggregationLevel } from "../../domain/types";
import { refreshCube } from "../../infrastructure/cube-builder";
import { getLayerFeatures } from "../get-layer-features";
import type { LayerFeaturesResult } from "../get-layer-features";
import { getPanoramaKpis } from "../get-panorama-kpis";
import { CUBE_STALE_MAX_MS, loadLayerFeaturesFromCube } from "../load-layer-features-cube";
import {
  KPI_CUBE_BIRTHS_KPI,
  KPI_CUBE_SCOPE_NATIONAL,
  loadPanoramaKpisFromCube,
} from "../load-panorama-kpis-cube";

const ADMIN: DashboardActor = { role: "admin" };
// Choropleth layers ignore the period entirely (current-state) — any `since` works.
const PERIOD = { since: new Date(0) };
const DRILL_PROVINCE = "La Pampa"; // Pampa flagship province (DIM-PAMP-0001).
// CB2 — cover the two cube-SERVED shapes La Pampa alone never exercises:
//   - CABA: the barrio-fold branch (build-features BARRIO_ONLY_PROVINCE) — CABA has
//     no departamentos, so its detail grain folds to barrios, a distinct code path.
//   - Buenos Aires: a large multi-department province whose LOCALITY-grain drill
//     folds hundreds of localities into partidos — the high-cardinality fold + the
//     `truncated` flag that La Pampa (small) never stresses.
const DRILL_CABA = "CABA";
const DRILL_BA = "Buenos Aires";

/** The ChoroplethMetric the "microchip" layer resolves to — the `case "microchip"`
 * arm of get-layer-features.ts. The cube rows are keyed by METRIC, not by layer
 * id, so the national+department case below needs the mapped name to census its
 * own groups. */
const MICROCHIP_METRIC = "microchip-penetration";

const CHOROPLETH_LAYERS: LayerId[] = [
  "cobertura",
  "esterilizacion",
  "microchip",
  "ppp",
  "mortalidad",
];

/** Order-independent normalized view of a FeatureCollection (geometry + props). */
function normFeatures(result: LayerFeaturesResult): string[] {
  return result.features.features
    .map((f) => JSON.stringify({ g: f.geometry, p: f.properties }))
    .sort();
}

/** The same normalized view, restricted to ONE province — for comparing a
 * national result against a single-province drill. */
function featuresOfProvince(result: LayerFeaturesResult, province: string): string[] {
  return result.features.features
    .filter((f) => (f.properties as { province?: string } | null)?.province === province)
    .map((f) => JSON.stringify({ g: f.geometry, p: f.properties }))
    .sort();
}

/**
 * A department/barrio cell as it reaches the map. CABA barrios carry no
 * departmentCode, so they key by province+locality instead.
 */
type CellProps = {
  departmentCode?: string | null;
  province?: string;
  locality?: string;
  value?: number | null;
  suppressed?: boolean;
};

const cellKey = (p: CellProps) =>
  p.departmentCode ? `d:${p.departmentCode}` : `b:${p.province ?? ""}:${p.locality ?? ""}`;

function indexCells(r: LayerFeaturesResult): Map<string, CellProps> {
  const m = new Map<string, CellProps>();
  for (const f of r.features.features) {
    const p = (f.properties ?? {}) as CellProps;
    m.set(cellKey(p), p);
  }
  return m;
}

/**
 * Ways a SERVED surface can break the k-anonymity floor: a readable sub-k
 * value, or a cell labelled suppressed that still ships its number. Empty is
 * the only acceptable answer, on both the cube and the live side.
 */
function privacyFloorBreaks(side: string, byKey: Map<string, CellProps>): string[] {
  const breaks: string[] = [];
  for (const [key, p] of byKey) {
    if (p.suppressed) {
      if (p.value != null) breaks.push(`${side} ${key}: suppressed but carries ${p.value}`);
    } else if (typeof p.value === "number" && p.value > 0 && p.value < 5) {
      breaks.push(`${side} ${key}: readable sub-k value ${p.value}`);
    }
  }
  return breaks;
}

// ---------------------------------------------------------------------------
// THE SUPPRESSION PARTITION vs THE SERVED SURFACE — read this before touching
// any per-group suppression count below.
// ---------------------------------------------------------------------------
//
// `complementarySuppress` (lib/metrics/anonymity.ts) guarantees a property of the
// PARTITION it returns: after the pass, a province group holds 0 or ≥2 suppressed
// cells. The FeatureCollection the map is served is NOT that partition — it is a
// LOSSY projection of it. `buildChoroplethFeatures` (../build-features.ts) drops
// every cell whose centroid is null (`pointFeature` returns geometry: null →
// `.filter(f => f.geometry !== null)`), because a cell with no coordinate can
// neither fill a polygon nor plot a dot.
//
// The cells that get dropped are exactly the ones most likely to BE the primary
// suppression: a locality name that matched no ar_localities row resolves no
// department AND no centroid, so the department fold keeps it as its own `loc:`
// bucket with a null coordinate, and such buckets are small. Measured on this
// seed (microchip, department grain): San Luis's complete rollup has ONE primary
// — `loc:Barrio 270 Viviendas`, count 3, unlocatable — which promotes the
// smallest visible sibling, department 74049 Junín (count 9). Both are suppressed
// in the cube ROWS; only 74049 survives into the FEATURES. Live, truncated to the
// national PER_LAYER_CAP, San Luis holds TWO primaries (that same bucket at 3 and
// 74007 Ayacucho at 4), so live promotes nothing and serves 74049 readable at 6.
// A textbook, correct complementary promotion — which a census taken off the
// served features reads as "one suppressed cell, no primary to complement".
//
// So: every per-group suppression census in this file is taken from the cube ROWS
// (the builder's own partition), through the ONE helper below. Counting them off
// a FeatureCollection is not a shortcut, it is a different — and wrong —
// population.

/** The cube-row fields the census reads. Structurally satisfied by a
 * `db.select().from(panoramaCube)` row. */
type CubeDeptRow = {
  metric: string;
  unitLevel: string;
  province: string;
  value: string | null;
  suppressed: boolean;
};

/** One (metric, province) group of the department-grain suppression partition. */
type GroupCensus = {
  suppressed: number;
  visible: number;
  /** Smallest published value still visible in the group; null when none is. */
  smallestVisible: number | null;
};

const censusKey = (metric: string, province: string) => `${metric}|${province}`;

/**
 * Census the department-grain suppression PARTITION per (metric, province),
 * straight from the cube rows the builder wrote. See the block above for why
 * this may never be computed from the served FeatureCollection.
 */
function censusCubeDepartmentRows(rows: readonly CubeDeptRow[]): Map<string, GroupCensus> {
  const out = new Map<string, GroupCensus>();
  for (const r of rows) {
    if (r.unitLevel !== "department") continue;
    const k = censusKey(r.metric, r.province);
    const g = out.get(k) ?? { suppressed: 0, visible: 0, smallestVisible: null };
    if (r.suppressed) {
      g.suppressed += 1;
    } else {
      g.visible += 1;
      if (r.value != null) {
        const v = Number(r.value);
        g.smallestVisible = g.smallestVisible === null ? v : Math.min(g.smallestVisible, v);
      }
    }
    out.set(k, g);
  }
  return out;
}

/** A department the CUBE suppresses while the LIVE path serves it readable. */
type OverSuppressed = { key: string; province: string; liveValue: number | null };

/**
 * Departments the CUBE suppresses while the LIVE path serves them readable.
 *
 * This set is NOT required to be empty — see the (2a) block below for the proof
 * that COMPLEMENTARY suppression legitimately produces exactly this shape. What
 * IS required is that every member fits the complementary footprint; that is
 * what `complementaryFootprintBreaks` checks.
 */
function overSuppressedByCube(
  liveByKey: Map<string, CellProps>,
  cubeByKey: Map<string, CellProps>,
): OverSuppressed[] {
  const out: OverSuppressed[] = [];
  for (const [key, lp] of liveByKey) {
    const cp = cubeByKey.get(key);
    if (cp && !lp.suppressed && cp.suppressed) {
      out.push({
        key,
        province: cp.province ?? lp.province ?? "",
        liveValue: typeof lp.value === "number" ? lp.value : null,
      });
    }
  }
  return out;
}

/**
 * The two properties a COMPLEMENTARY suppression cannot violate, checked per
 * province group. Anything outside them is a real builder/loader floor drift,
 * because primary (k) suppression provably cannot over-suppress at all — see the
 * (2a) block.
 *
 *  (i) CARDINALITY — `complementarySuppress` promotes AT MOST ONE cell per group
 *      (its `toPromote` set takes one smallest-visible sibling per group, and the
 *      cube runs exactly one pass per province). Two live-readable departments
 *      suppressed by the cube in the same province cannot be complementary.
 *
 *  (ii) MAGNITUDE — the promoted cell is the SMALLEST cell that was still
 *      visible, so its true count is ≤ every cell that REMAINS visible in the
 *      cube for that province. The live value is an undercount of that true
 *      count (live truncates localities before folding), hence
 *      `liveValue ≤ min(visible cube values in the province)`. A builder that
 *      suppressed a LARGE department — the signature of a drifted floor — breaks
 *      this even when it only does it once per province.
 *
 * Department-grain cube values are raw counts (`toChoroplethCells` sets
 * `value: r.count` for every metric), which is the same quantity
 * `complementarySuppress` orders by — so the magnitude comparison is apples to
 * apples.
 *
 * BOTH bounds are statements about the PARTITION, so both are measured on the
 * cube ROWS (`census`), never on the served features — see the partition-vs-
 * surface block above for the shape that taught us the difference.
 */
function complementaryFootprintBreaks(
  over: readonly OverSuppressed[],
  metric: string,
  census: ReadonlyMap<string, GroupCensus>,
): string[] {
  const breaks: string[] = [];
  const byProvince = new Map<string, OverSuppressed[]>();
  for (const o of over) byProvince.set(o.province, [...(byProvince.get(o.province) ?? []), o]);

  for (const [province, entries] of byProvince) {
    const group = census.get(censusKey(metric, province)) ?? {
      suppressed: 0,
      visible: 0,
      smallestVisible: null,
    };
    const smallestVisible = group.smallestVisible;
    const suppressedInGroup = group.suppressed;

    if (entries.length > 1) {
      breaks.push(
        `${province}: ${entries.length} departments (${entries
          .map((e) => e.key)
          .join(
            ", ",
          )}) are readable live but suppressed in the cube — complementary suppression promotes at most ONE cell per province`,
      );
    }
    // A promotion never leaves a lone suppressed cell: the promoted cell sits
    // beside the primary that triggered it, so the group holds ≥ 2.
    if (suppressedInGroup < 2) {
      breaks.push(
        `${province}: cube suppressed ${entries.map((e) => e.key).join(", ")} but the province group holds only ${suppressedInGroup} suppressed cell(s) — no primary suppression to complement`,
      );
    }
    for (const e of entries) {
      if (e.liveValue != null && smallestVisible !== null && e.liveValue > smallestVisible) {
        breaks.push(
          `${province} ${e.key}: cube suppressed a department whose live value ${e.liveValue} already exceeds the smallest cell the cube still publishes there (${smallestVisible}) — it cannot be the smallest-visible sibling a complementary promotion picks`,
        );
      }
    }
  }
  return breaks;
}

const prevFlag = process.env.CUBE_READS;

beforeAll(async () => {
  process.env.CUBE_READS = "1";
  const r = await refreshCube();
  expect(r.status).toBe("ok");
  expect(r.rowCount).toBeGreaterThan(0);
  // The KPI-strip phase (migration 0151) rides the same refresh run.
  expect(r.kpi.status).toBe("ok");
  expect(r.kpi.rowCount).toBeGreaterThan(0);
}, 240_000);

afterAll(() => {
  // Restore the pre-suite value (flag default is ON since the cube-ON decision;
  // '0' is the only disabling value, so "" restores the default-ON behavior).
  process.env.CUBE_READS = prevFlag ?? "";
});

// Cube-eligible combos (set-equal, order-independent, to live): national+province, and
// BOTH grains for a whole-province drill. National+department is ALSO cube-served now,
// but as a deliberate SUPERSET over the truncated live view (capped at PER_LAYER_CAP) —
// asserted separately below (superset containment, not set-equality).
const ELIGIBLE: { level: AggregationLevel; drill?: string }[] = [
  { level: "province", drill: undefined },
  { level: "province", drill: DRILL_PROVINCE },
  { level: "locality", drill: DRILL_PROVINCE },
  // CB2 — CABA (barrio-fold branch) at both grains.
  { level: "province", drill: DRILL_CABA },
  { level: "locality", drill: DRILL_CABA },
  // CB2 — Buenos Aires (large multi-department province) at both grains.
  { level: "province", drill: DRILL_BA },
  { level: "locality", drill: DRILL_BA },
];

describe("cube == live parity (5 metrics; national+province + whole-province drill)", () => {
  for (const layer of CHOROPLETH_LAYERS) {
    for (const { level, drill } of ELIGIBLE) {
      const scopeLabel = drill ? `drill ${drill}` : "national";
      it(`${layer} @ ${level} — ${scopeLabel}`, async () => {
        const [live, cube] = await Promise.all([
          getLayerFeatures(layer, ADMIN, [], PERIOD, level, drill),
          loadLayerFeaturesFromCube(layer, ADMIN, level, drill),
        ]);
        expect(cube, "cube must serve this eligible request").not.toBeNull();
        const cubeResult = cube as NonNullable<typeof cube>;

        // Envelope parity.
        expect(cubeResult.result.level).toBe(live.level);
        expect(cubeResult.result.suppressedCount).toBe(live.suppressedCount);
        expect(cubeResult.result.noLocalityCount).toBe(live.noLocalityCount);
        expect(cubeResult.result.truncated).toBe(live.truncated);

        // Feature parity (order-independent, geometry + properties).
        expect(normFeatures(cubeResult.result)).toEqual(normFeatures(live));
        // CB2: 180s per case. The LIVE side of a large-province LOCALITY drill is far
        // slower than the 5s default — the cobertura rabies trailing-12m EXISTS over
        // every Buenos Aires locality measures ~96s live (exactly the query the cube
        // exists to replace; the cube read itself is instant). This bounds only the
        // live comparison the parity assertion needs, never the cube path.
      }, 180_000);
    }
  }

  it("national + department view IS cube-served as a SUPERSET over the truncated live set", async () => {
    const [live, cube] = await Promise.all([
      getLayerFeatures("microchip", ADMIN, [], PERIOD, "locality"),
      loadLayerFeaturesFromCube("microchip", ADMIN, "locality"),
    ]);
    expect(cube, "cube must serve national+department").not.toBeNull();
    const cubeResult = (cube as NonNullable<typeof cube>).result;

    // The cube national+department envelope is a SUPERSET over the live global
    // cap (built per province, so it ADDS the departments the live path dropped).
    // Its `truncated` is DERIVED from the per-province build flags (den=1), NOT
    // hardcoded — on this seed no province's own rollup hit PER_LAYER_CAP, so it
    // is honestly false; a real BA-scale build that capped a province would flip
    // it true (the honest signal an operator needs). The live path IS truncated
    // here — that global-cap truncation is exactly the defect the cube supersedes.
    expect(cubeResult.level).toBe("locality");
    expect(cubeResult.truncated).toBe(false); // seed: no province build was capped
    expect(live.truncated).toBe(true);

    const liveByKey = indexCells(live);
    const cubeByKey = indexCells(cubeResult);

    // (1) COVERAGE SUPERSET: every department visible live is present in the cube
    // (the cube only ever ADDS the departments the live PER_LAYER_CAP truncation
    // dropped — it never loses one).
    for (const key of liveByKey.keys()) {
      expect(cubeByKey.has(key), `live department ${key} must exist in the cube superset`).toBe(
        true,
      );
    }
    // The cube covers at least as many departments as the truncated live set.
    expect(cubeByKey.size).toBeGreaterThanOrEqual(liveByKey.size);

    // (2) SUPPRESSION — the half this test was blind to. The value loop below
    // compares only cells where BOTH sides carry a NUMBER, and a suppressed
    // cell carries `value: null` by construction, so every suppressed cell fell
    // straight through it. Flipping a cell's suppression either way changed
    // nothing this test could see — on the one combo (national + department)
    // whose features the set-equal parity block above does NOT compare
    // field-for-field.
    //
    // Set EQUALITY is not the assertion here, and measuring says so: on this
    // seed five La Rioja departments (46007/46028/46049/46084/46105) are
    // suppressed live and readable in the cube, because live truncates
    // localities BEFORE folding and its undercount lands under the k floor
    // while the cube's complete count (6…24) clears it. That direction is the
    // superset working as designed. What follows are the two invariants that
    // ARE sound, and between them they pin both directions of a suppression
    // regression.
    //
    // (2a) THE OTHER DIRECTION, CORRECTLY BOUNDED.
    //
    // This block used to assert the set was EMPTY: "a department readable LIVE
    // must never come back suppressed from the cube". That was UNSOUND, and it
    // failed in CI (run 31024891161) on legitimate behavior while passing
    // locally — a data-dependent trap, not a race. The reasoning behind the
    // empty-set claim only covered PRIMARY (k) suppression:
    //
    //   The cube's per-province rollup is a SUPERSET of the live national
    //   rollup restricted to that province (live caps at PER_LAYER_CAP globally,
    //   the cube caps per province and no province approaches the cap), so
    //   cubeCount ≥ liveCount for every department. Primary suppression needs
    //   cubeCount < k ≤ liveCount — impossible. So primary suppression can
    //   NEVER over-suppress. That half of the argument is sound.
    //
    // What it missed: `complementarySuppress` (lib/metrics/anonymity.ts), which
    // both paths run AFTER the k pass. A province group with EXACTLY ONE
    // primary-suppressed department also loses its smallest visible sibling, so
    // no lone hidden cell is recoverable by subtraction. The two sides run that
    // pass over DIFFERENT inputs — the cube over the complete province, live
    // over a TRUNCATED subset of it — so they legitimately promote different
    // cells, or the cube promotes where live has ≥2 primaries and promotes
    // nothing. (That subset is no longer ARBITRARY: since 2026-08-05 the cap
    // orders by `n DESC, province, locality`, so live keeps the largest
    // localities and the same subset on every run. Deterministic and closer to
    // the cube — which TIGHTENS these bounds, it does not relax them: live
    // undercounts less, so fewer departments fall under k that the cube clears.
    // What stays true is that the two inputs are still DIFFERENT, which is all
    // this argument needs.)
    //
    // Measured on this seed (microchip, department grain): Córdoba has exactly
    // ONE sub-k department (14154, count 3) and the cube promotes 14070
    // (count 7); Entre Ríos promotes 30088 (5) beside 30042 (3); Formosa
    // promotes 34056 (7) beside 34028 (4). All three promoted departments are
    // ABOVE k. They only stay invisible to the old assertion because live's
    // truncation happens to push them under k as well — one different pet, one
    // different plan, one fresh CI bootstrap, and any of them shows up readable
    // live while the cube (correctly) withholds it.
    //
    // So the assertion is now the SHAPE of a legitimate promotion, not its
    // absence. It still catches the real defect it exists for:
    //   · a drifted floor over-suppressing several departments in a province →
    //     breaks the ≤1-per-province cardinality bound;
    //   · a drifted floor over-suppressing a LARGE department → breaks the
    //     magnitude bound (a promotion can only ever take the smallest cell);
    //   · a builder suppressing with no primary to complement → breaks the
    //     ≥2-suppressed-in-group bound;
    //   · and, decisively, every affected province is re-checked below against
    //     its own COMPLETE live drill, field for field.
    const over = overSuppressedByCube(liveByKey, cubeByKey);
    const census = censusCubeDepartmentRows(await db.select().from(panoramaCube));
    expect(
      complementaryFootprintBreaks(over, MICROCHIP_METRIC, census),
      "the cube suppressed a department the live path serves readable, in a shape complementary suppression cannot produce — the k-anonymity floor drifted between builder and loader",
    ).toEqual([]);

    // (2a-bis) THE APPLES-TO-APPLES RE-CHECK. The comparison above is unavoidably
    // lopsided (complete cube vs truncated live), which is the whole reason a raw
    // set difference proves nothing. For every province where the two sides DID
    // disagree, compare against the one live read that is NOT truncated: that
    // province's own drill, which the loaders serve complete. The cube's national
    // department cells for a province are the same rows a cube drill returns
    // (readCubeRows filters by province), so a floor drift in the builder shows up
    // here as a field-level difference, and truncation cannot mask it.
    for (const province of new Set(over.map((o) => o.province))) {
      const liveDrill = await getLayerFeatures(
        "microchip",
        ADMIN,
        [],
        PERIOD,
        "locality",
        province,
      );
      expect(
        featuresOfProvince(cubeResult, province),
        `cube national+department cells for ${province} must equal that province's complete live drill (the truncation-free reference)`,
      ).toEqual(featuresOfProvince(liveDrill, province));
    }

    // (2b) THE FLOOR ITSELF, on the SERVED surface (not just on panoramaCube
    // rows): every readable department respects k=5, and every suppressed one
    // actually withholds its number. This is what catches the other direction —
    // a builder that stops suppressing sub-k cells, or one that labels a cell
    // "suppressed" while still shipping the value.
    expect(
      [...privacyFloorBreaks("live", liveByKey), ...privacyFloorBreaks("cube", cubeByKey)],
      "the served national+department surface breaks the privacy floor (sub-k readable, or a suppressed cell still carrying its value)",
    ).toEqual([]);

    // (3) VALUES COMPLETE THE PARTIAL SUM: live truncates localities BEFORE folding
    // to departments, so a partially-truncated department's live value is an
    // undercount. The cube (complete per-province) is therefore ≥ the live value on
    // every overlapping VISIBLE department — the cube never undercounts the live set.
    for (const [key, lp] of liveByKey) {
      const cp = cubeByKey.get(key);
      if (!cp) continue;
      if (typeof lp.value === "number" && typeof cp.value === "number") {
        expect(
          cp.value,
          `cube must not undercount live for ${key} (cube ${cp.value} < live ${lp.value})`,
        ).toBeGreaterThanOrEqual(lp.value);
      }
    }
    // 300s (was 180s): the live national read is the bulk of it, and (2a-bis) can
    // add ONE live province drill per province where the two sides disagreed — a
    // Buenos Aires drill alone measures ~96s.
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Govt jurisdiction-scoped correctness (Panorama-level integration coverage,
// not just scope.ts unit tests).
// ---------------------------------------------------------------------------
//
// The layer cube is ADMIN-ONLY by design (load-layer-features-cube.ts header:
// "govt stays live in v1") — a govt actor NEVER reads from it, always live.
// So a govt request can't be cube-vs-cube parity-tested. What CAN be checked
// at this integration level: a govt actor assigned a WHOLE province must see
// EXACTLY the population the cube stores for that province.
//
// This case uses CABA's INDEC whole-city locality-of-record, the form that has
// always subsumed every barrio. Since D3 (PO 2026-08-04) the generic sentinel
// `{ locality: "" }` ALSO means "toda la provincia" for any canonical province
// — jurisdictionPairClause (lib/metrics/scope.ts) widens to province-only for
// both forms via isWholeProvinceLocality. CABA is kept here because it is the
// province this parity fixture has data for; the assertion is about cube-vs-live
// parity, not about which sentinel form was used.
describe("govt jurisdiction-scoped correctness (field-diff live-govt vs live-national drill)", () => {
  const GOVT: DashboardActor = { role: "govt" };
  const NATIONAL: DashboardActor = { role: "national" };
  // The whole-CABA INDEC locality (lib/domain/jurisdiction-canonical.ts
  // WHOLE_PROVINCE_LOCALITY.CABA) — the ONE assignment form that subsumes
  // every barrio, matching a national-read adminProvince="CABA" drill.
  const WHOLE_CABA = "Ciudad Autónoma de Buenos Aires";
  const GOVT_WHOLE_CABA: DashboardJurisdiction[] = [{ province: DRILL_CABA, locality: WHOLE_CABA }];

  // WHY NOT THE CUBE (T1-P1, PO D3 2026-09-18): govt no longer sees seed-tagged
  // (synthetic) rows, and the cube is built as ADMIN — it counts them. "govt
  // live equals the cube admin drill" is therefore false BY DESIGN, and the
  // cube cannot be filtered per viewer. The same scope-decomposition claim
  // still holds, one link at a time, with no loosening of the field-diff:
  //   (1) HERE: govt (whole CABA) live == a `national` CABA drill live. Both
  //       apply the SAME synthetic exclusion (only admin sees synthetic rows),
  //       so this proves the govt jurisdiction scope decomposes exactly like a
  //       whole-province drill — envelope and every feature.
  //   (2) ABOVE ("cube == live parity", drill CABA): the admin CABA drill live
  //       == the cube admin drill. The cube keeps serving admin exactly.
  for (const layer of CHOROPLETH_LAYERS) {
    for (const level of ["province", "locality"] as const) {
      it(`${layer} @ ${level} — govt (whole CABA) live equals the national CABA drill live`, async () => {
        const [liveGovt, liveNational] = await Promise.all([
          getLayerFeatures(layer, GOVT, GOVT_WHOLE_CABA, PERIOD, level),
          getLayerFeatures(layer, NATIONAL, [], PERIOD, level, DRILL_CABA),
        ]);
        // A national viewer is never served from the admin-built cube.
        expect(await loadLayerFeaturesFromCube(layer, NATIONAL, level, DRILL_CABA)).toBeNull();

        // Envelope parity.
        expect(liveGovt.level).toBe(liveNational.level);
        expect(liveGovt.suppressedCount).toBe(liveNational.suppressedCount);
        expect(liveGovt.noLocalityCount).toBe(liveNational.noLocalityCount);
        expect(liveGovt.truncated).toBe(liveNational.truncated);

        // Feature parity (order-independent, geometry + properties) — the same
        // field-diff the admin parity block above runs.
        expect(normFeatures(liveNational)).toEqual(normFeatures(liveGovt));
      }, 180_000);
    }
  }

  it("the layer cube never serves a govt actor directly (admin-only invariant, checked at the integration boundary)", async () => {
    for (const layer of CHOROPLETH_LAYERS) {
      expect(await loadLayerFeaturesFromCube(layer, GOVT, "province", DRILL_CABA)).toBeNull();
      expect(await loadLayerFeaturesFromCube(layer, GOVT, "locality", DRILL_CABA)).toBeNull();
    }
  });
});

describe("sub-k invariant (privacy floor baked into the readable surface)", () => {
  it("no unsuppressed department row has 0 < value < 5", async () => {
    const rows = await db.select().from(panoramaCube);
    const leaks = rows.filter(
      (r) =>
        r.unitLevel === "department" &&
        !r.suppressed &&
        r.value != null &&
        Number(r.value) > 0 &&
        Number(r.value) < 5,
    );
    expect(leaks).toEqual([]);
  });

  it("no province group has exactly one suppressed department with a visible sibling", async () => {
    // Same census helper the (2a) footprint guard uses — one definition of "how
    // many cells did the builder suppress in this group", so the two checks
    // cannot drift into measuring different populations (which is exactly how
    // the (2a) guard once ended up counting off the rendered features).
    const census = censusCubeDepartmentRows(await db.select().from(panoramaCube));
    const differenceable = [...census.entries()].filter(
      ([, g]) => g.suppressed === 1 && g.visible >= 1,
    );
    expect(differenceable).toEqual([]);
  });
});

describe("staleness gate falls back to live", () => {
  it("status != 'ok' → reader returns null", async () => {
    await db.update(panoramaCubeMeta).set({ status: "error" });
    const r = await loadLayerFeaturesFromCube("cobertura", ADMIN, "province");
    expect(r).toBeNull();
    // restore
    await db.update(panoramaCubeMeta).set({ status: "ok" });
  });

  it("built_at older than STALE_MAX → reader returns null", async () => {
    // One hour past the staleness ceiling (26h daily-cadence window).
    const old = new Date(Date.now() - (CUBE_STALE_MAX_MS + 60 * 60 * 1000));
    await db.update(panoramaCubeMeta).set({ builtAt: old, status: "ok" });
    const r = await loadLayerFeaturesFromCube("cobertura", ADMIN, "province");
    expect(r).toBeNull();
    // restore a fresh build for any later reads
    await db.update(panoramaCubeMeta).set({ builtAt: new Date() });
  });
});

// ---------------------------------------------------------------------------
// KPI-strip cube (migration 0151) — the honesty fence for the whole feature:
// for the seeded dataset, a cube-read strip must equal the live-read strip.
// ---------------------------------------------------------------------------

/** The period the KPI cube was built for (stored on its meta row). Passing it
 * VERBATIM to the live fan-out makes the comparison window-identical — the only
 * residual nondeterminism is the handful of now-anchored fixed windows inside
 * the fetchers (e.g. perdidas "recuperadas 30d"), whose boundary would have to
 * cross a seeded event within the seconds between build and assertion. */
async function storedKpiPeriod(): Promise<AnalyticsPeriod> {
  const [meta] = await db.select().from(panoramaKpiCubeMeta);
  expect(meta?.periodSince).toBeTruthy();
  expect(meta?.periodUntil).toBeTruthy();
  return {
    since: meta.periodSince as Date,
    until: meta.periodUntil as Date,
  };
}

describe("KPI strip cube == live parity (admin national, panorama default period)", () => {
  it("cube-served strip equals the live fan-out field-for-field", async () => {
    const period = await storedKpiPeriod();
    const [cube, live] = await Promise.all([
      loadPanoramaKpisFromCube({ actor: ADMIN, jurisdictions: [], period }),
      getPanoramaKpis(ADMIN, [], period),
    ]);
    expect(cube, "cube must serve the eligible admin-national request").not.toBeNull();
    const served = (cube as NonNullable<typeof cube>).value;

    // Envelope parity: tiles (order included — display order is contract),
    // caption, freshness, and the footer denominator. `toEqual` treats an
    // undefined property and an absent one as equal, which is exactly the
    // jsonb round-trip's behavior (undefined fields are dropped at store).
    expect(served.kpis).toEqual(live.kpis);
    expect(served.recalculatedFor).toBe(live.recalculatedFor);
    expect(served.dataAsOf).toBe(live.dataAsOf);
    expect(served.coverageDenominator).toEqual(live.coverageDenominator ?? null);
    // A cube strip is never the degraded payload (builder honesty fence).
    expect(served.degraded).toBeUndefined();
    expect(served.kpis.some((k) => k.unavailable)).toBe(false);
  }, 180_000);

  it("births row (the cubed pregnancy/litter gap) equals live fetchNetGrowth", async () => {
    const period = await storedKpiPeriod();
    const [row] = await db
      .select()
      .from(panoramaKpiCube)
      .where(
        and(
          eq(panoramaKpiCube.scope, KPI_CUBE_SCOPE_NATIONAL),
          eq(panoramaKpiCube.kpi, KPI_CUBE_BIRTHS_KPI),
        ),
      );
    expect(row, "the builder must store a births row").toBeTruthy();
    // position NULL = not a strip tile — never assembled into the served strip.
    expect(row.position).toBeNull();
    const live = await fetchNetGrowth(buildProjectionContext(ADMIN, [], period));
    expect(row.payload).toEqual(live);
    // And indeed the served strip carries no births tile (no such tile exists).
    const cube = await loadPanoramaKpisFromCube({ actor: ADMIN, jurisdictions: [], period });
    expect(
      (cube as NonNullable<typeof cube>).value.kpis.some(
        (k) => (k.id as string) === KPI_CUBE_BIRTHS_KPI,
      ),
    ).toBe(false);
  }, 60_000);
});

describe("KPI cube eligibility + staleness gates fall back to live (null)", () => {
  it("ineligible requests: flag off / non-admin / drill / scrub / scoped / period mismatch", async () => {
    const period = await storedKpiPeriod();
    const eligible = { actor: ADMIN, jurisdictions: [], period };

    // '0' is the kill switch (flag default is ON since the cube-ON decision).
    process.env.CUBE_READS = "0";
    expect(await loadPanoramaKpisFromCube(eligible)).toBeNull();
    process.env.CUBE_READS = "1";

    expect(await loadPanoramaKpisFromCube({ ...eligible, actor: { role: "govt" } })).toBeNull();
    expect(
      await loadPanoramaKpisFromCube({ ...eligible, adminProvince: DRILL_PROVINCE }),
    ).toBeNull();
    expect(await loadPanoramaKpisFromCube({ ...eligible, asOf: new Date() })).toBeNull();
    expect(
      await loadPanoramaKpisFromCube({
        ...eligible,
        jurisdictions: [{ province: "La Pampa", locality: "Santa Rosa" }],
      }),
    ).toBeNull();
    // A different preset (12m vs the stored landing window — 90d since QA
    // fix 7 aligned the build to defaultPanoramaPresetPeriod()) misses the
    // period gate.
    const twelveMonths: AnalyticsPeriod = {
      since: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      until: new Date(),
    };
    expect(await loadPanoramaKpisFromCube({ ...eligible, period: twelveMonths })).toBeNull();
  }, 60_000);

  it("meta status != 'ok' → null; built_at older than STALE_MAX → null", async () => {
    const period = await storedKpiPeriod();
    const eligible = { actor: ADMIN, jurisdictions: [], period };

    await db.update(panoramaKpiCubeMeta).set({ status: "error" });
    expect(await loadPanoramaKpisFromCube(eligible)).toBeNull();
    await db.update(panoramaKpiCubeMeta).set({ status: "ok" });

    // One hour past the staleness ceiling (26h daily-cadence window).
    const old = new Date(Date.now() - (CUBE_STALE_MAX_MS + 60 * 60 * 1000));
    await db.update(panoramaKpiCubeMeta).set({ builtAt: old });
    expect(await loadPanoramaKpisFromCube(eligible)).toBeNull();
    // restore a fresh stamp for any later reads
    await db.update(panoramaKpiCubeMeta).set({ builtAt: new Date() });
  }, 60_000);
});

describe("builder idempotency", () => {
  it("running the builder twice yields the same rows and advances built_at", async () => {
    const before = await db.select().from(panoramaCube).orderBy(asc(panoramaCube.unitCode));
    const [metaBefore] = await db.select().from(panoramaCubeMeta);

    const r = await refreshCube();
    expect(r.status).toBe("ok");

    const after = await db.select().from(panoramaCube).orderBy(asc(panoramaCube.unitCode));
    const [metaAfter] = await db.select().from(panoramaCubeMeta);

    // Same row set (content-identical, ignoring row order via the shared ordering).
    const norm = (rows: typeof before) =>
      rows
        .map((x) => JSON.stringify(x))
        .sort()
        .join("\n");
    expect(norm(after)).toBe(norm(before));
    expect(metaAfter.rowCount).toBe(metaBefore.rowCount);
    // built_at advanced (or stayed equal only if the two runs landed in the same ms).
    expect(metaAfter.builtAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      metaBefore.builtAt?.getTime() ?? 0,
    );
  }, 240_000);
});
