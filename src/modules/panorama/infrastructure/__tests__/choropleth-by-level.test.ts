// DB-backed integration tests for the U5 aggregation-axis rollup.
//
// These run against the local Postgres seeded by `seed:panorama`
// (vitest.config.ts → setup.ts forces 127.0.0.1:54322). They verify the CORE
// U5 invariant the spec asserts: a PROVINCE rollup equals the SUM of its
// LOCALITY rollups, because both share the same metric predicate + scope and
// differ only in the GROUP BY. They also check province coverage (≤24 valid
// jurisdictions), k-anon at BOTH grains (#40 — this used to read "k-anon
// asymmetry: province never suppresses", which was the leak, not the design:
// province cells now apply k=5 to their DENOMINATOR), and the level-overload
// routing.
//
// PERFORMANCE NOTE: at panorama-seed scale (~45k pets) the rabies-coverage
// LOCALITY rollup is pathologically slow (~50s) because its centroid join uses
// a functional `unaccent(regexp_replace(...))` predicate with no functional
// index AND an EXISTS rabies subquery over the full table — a PRE-EXISTING
// characteristic of loadRabiesCoverage, not U5. The MORTALITY rollups are fast
// (status='deceased' filters to ~150 rows before the join), and the rabies
// PROVINCE rollup is fast (no centroid join). So we exercise:
//   - the locality-level invariant via MORTALITY (fast + real), and
//   - the province path via both metrics (both fast).
// The rabies locality path is covered structurally (the metric predicate is
// shared verbatim by both levels) + by the mocked use-case unit tests.
//
// Admin scope (universal) is used so the rollups see the whole seeded dataset.

import { describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import type { DashboardActor } from "@/lib/metrics";
import { PROVINCES } from "@/lib/reference/ar-provincias";

import {
  loadChoroplethByLevel,
  loadMortality,
  loadMortalityByProvince,
  loadRabiesCoverageByProvince,
} from "../repository";

const ADMIN: DashboardActor = { role: "admin" };
const VALID_CODES = new Set<string>(PROVINCES.map((p) => p.code));

// Province display name → ISO code (the repository maps this internally; we
// mirror it here to bucket locality cells back to their province for the sum).
const NAME_TO_CODE = new Map<string, string>(PROVINCES.map((p) => [p.name, p.code]));

describe("U5 rollup — province total equals the sum of its localities (mortality)", () => {
  it("province cells reconcile with their constituent locality cells", async () => {
    const [prov, loc] = await Promise.all([
      loadMortalityByProvince(ADMIN, []),
      loadMortality(ADMIN, []),
    ]);

    // #40: the province cell is now k-anon'd too — a province with a sub-k
    // deceased count publishes `value: null`. It is EXCLUDED from the
    // reconciliation rather than read as 0: there is no province total to
    // reconcile against, and treating the withheld cell as zero would make this
    // test demand that its localities sum to nothing.
    const provTotalByCode = new Map<string, number>();
    for (const c of prov.cells) {
      if (c.suppressed || c.value === null) continue;
      provTotalByCode.set(c.provinceCode, c.value);
    }

    // The locality cells are k-anon'd: a SUPPRESSED cell carries value=null.
    // A PRIMARY (k=5) suppression hides a count in [1, 4] — but `toChoroplethCells`
    // also runs `complementarySuppress` (1ed90200): when a province has EXACTLY
    // one primary-suppressed department, it additionally promotes that
    // province's smallest VISIBLE department into suppression too, to defeat a
    // differencing attack against the (unsuppressed) province total. That
    // promoted cell can hide ANY count >= 5 — not bounded by 4 — so
    // "suppressedCount*4" is NOT a valid upper bound once a promotion has
    // fired (found via the Santa Fe department split: La Capital hides 4
    // (primary, within [1,4]) while Rosario — genuinely 7 pets — gets
    // COMPLEMENTARY-promoted and hides 7, three over the naive bound; every
    // locality here is a canonical, correctly-resolved ar_localities row —
    // this is the shared suppression helper working as designed, not a seed
    // or locality-catalog defect).
    //
    // So the lower bound (every suppressed cell hides >= 1) still holds
    // unconditionally, but the tight upper bound is only provable by
    // reconciling against the TRUE raw per-locality distribution directly
    // (test-only elevated DB access), bypassing the loader's k-anon layer
    // entirely rather than trying to reconstruct it from suppressed output.
    const visibleSumByCode = new Map<string, number>();
    const suppressedCountByCode = new Map<string, number>();
    for (const cell of loc.cells) {
      const code = NAME_TO_CODE.get(cell.province);
      if (!code) continue;
      if (cell.suppressed) {
        suppressedCountByCode.set(code, (suppressedCountByCode.get(code) ?? 0) + 1);
      } else {
        visibleSumByCode.set(code, (visibleSumByCode.get(code) ?? 0) + (cell.value ?? 0));
      }
    }

    // Pets counted at province level but INVISIBLE at locality level: the
    // locality rollup filters `jurisdiction_locality IS NOT NULL` (it can only
    // paint geocodable cells), while the province rollup counts every pet in
    // the province. Deceased pets with a NULL locality (e.g. the 2026-07-04
    // drift reconciliation marked ~3.3k PANO pets deceased, many without
    // locality) are a legitimate residual, not a projection bug — so the
    // accounting identity must include it:
    //   provTotal == visibleSum + hiddenSuppressed + nullLocality
    // Surfacing this residual in the UI ("X sin localidad asignada") is
    // tracked in the gob data-quality slice (task #44).
    const nullLocRows = await db.execute<{ province: string; n: string }>(sql`
      SELECT jurisdiction_province AS province, COUNT(*) AS n
      FROM pets
      WHERE status = 'deceased'
        AND jurisdiction_province IS NOT NULL
        AND jurisdiction_locality IS NULL
      GROUP BY jurisdiction_province
    `);
    const nullLocByCode = new Map<string, number>();
    for (const r of nullLocRows) {
      const code = NAME_TO_CODE.get(r.province);
      if (code) nullLocByCode.set(code, Number(r.n));
    }

    // TRUE per-locality total (pre-suppression, pre-department-fold — the same
    // `status = 'deceased'` predicate + `jurisdiction_locality IS NOT NULL`
    // filter `loadMortality`'s rollup uses), queried directly so the upper-bound
    // check doesn't have to reconstruct a k-anon'd value from suppressed output
    // (see the complementary-suppression note above for why that reconstruction
    // is unsound). This is test-only elevated access — never something the
    // public loader itself would expose.
    const rawLocalityRows = await db.execute<{ province: string; n: string }>(sql`
      SELECT jurisdiction_province AS province, COUNT(*) AS n
      FROM pets
      WHERE status = 'deceased'
        AND jurisdiction_locality IS NOT NULL
      GROUP BY jurisdiction_province
    `);
    const rawLocalitySumByCode = new Map<string, number>();
    for (const r of rawLocalityRows) {
      const code = NAME_TO_CODE.get(r.province);
      if (code) rawLocalitySumByCode.set(code, Number(r.n));
    }

    // Under PER_LAYER_CAP truncation the locality layer legitimately DROPS
    // whole tail provinces (the 2026-07-04 drift reconciliation pushed the
    // deceased locality rollup past the cap for the first time). The exact
    // identity only holds untruncated; when truncated, only the lower bound
    // survives (visible cells can never exceed the province total).
    let provincesChecked = 0;
    for (const [code, provTotal] of provTotalByCode) {
      if (loc.truncated) {
        const visibleSumT = visibleSumByCode.get(code) ?? 0;
        const suppressedT = suppressedCountByCode.get(code) ?? 0;
        // Strict lower bound: truncation only REMOVES cells, so the cells
        // that survive can never sum past the province total.
        expect(provTotal).toBeGreaterThanOrEqual(visibleSumT + suppressedT);
        provincesChecked += 1;
        continue;
      }
      const visibleSum = visibleSumByCode.get(code) ?? 0;
      const suppressed = suppressedCountByCode.get(code) ?? 0;
      const nullLoc = nullLocByCode.get(code) ?? 0;
      const rawLocalitySum = rawLocalitySumByCode.get(code) ?? 0;
      // Lower bound: every suppressed cell — primary OR complementary-promoted
      // — hides a REAL, nonzero count (k-anon never suppresses a true zero row;
      // complementary promotion only ever moves an already-visible, >=5 cell).
      expect(provTotal).toBeGreaterThanOrEqual(visibleSum + suppressed + nullLoc);
      // Exact reconciliation: the province total from `loadMortalityByProvince`
      // must equal the TRUE raw per-locality distribution plus the null-locality
      // residual — verified directly, not bounded via a k-anon estimate. This
      // is what actually catches a predicate/scope drift between the two
      // loaders; it is unaffected by complementary suppression because it
      // never routes through the suppression layer at all.
      expect(provTotal).toBe(rawLocalitySum + nullLoc);
      // Where nothing is suppressed, the LOADER's own visible sum (not just the
      // raw SQL) must also match exactly — proving loadMortality's public
      // output reconciles too, not only the underlying table.
      if (suppressed === 0) expect(provTotal).toBe(visibleSum + nullLoc);
      provincesChecked += 1;
    }

    // Every province cell must reconcile against the locality partition.
    expect(provincesChecked).toBeGreaterThan(0);
    expect(provincesChecked).toBe(provTotalByCode.size);
  }, 30_000);
});

describe("U5 province choropleth coverage", () => {
  it("returns at most 24 cells, each a valid AR jurisdiction code with a positive value", async () => {
    const prov = await loadMortalityByProvince(ADMIN, []);
    expect(prov.cells.length).toBeGreaterThan(0);
    expect(prov.cells.length).toBeLessThanOrEqual(24);
    const seen = new Set<string>();
    for (const c of prov.cells) {
      expect(VALID_CODES.has(c.provinceCode)).toBe(true);
      // #40: the value contract is now conditional on suppression. A protected
      // cell has NO value (null, never 0); a visible one must clear k, because
      // on a density layer the count IS the denominator.
      if (c.suppressed) {
        expect(c.value).toBeNull();
      } else {
        expect(c.value ?? 0).toBeGreaterThanOrEqual(5);
      }
      expect(c.label.length).toBeGreaterThan(0);
      // No duplicate province cells (one row per province).
      expect(seen.has(c.provinceCode)).toBe(false);
      seen.add(c.provinceCode);
    }
  }, 30_000);
});

describe("U5 k-anon at both grains", () => {
  // ⚠️ REWRITTEN (#40). This described a "k-anon ASYMMETRY" and asserted
  // "province cells are NEVER suppressed (large cells, no k-anon)" — a test
  // that ratified the leak. The premise confused a province's POPULATION with
  // its DENOMINATOR: on a rate layer they are different numbers, and Santa Cruz
  // publishing 100% over 11 dogs has a value of 100, not 11. Both grains now
  // carry k=5; only the unit differs.
  it("province cells obey the k-anon contract: suppressed ⇔ null value, never a number", async () => {
    // Rabies PROVINCE rollup (fast: no centroid join). The DENOMINATOR is the
    // dogs in scope — a province with fewer than 5 publishes no rate.
    const prov = await loadRabiesCoverageByProvince(ADMIN, []);
    expect(prov.cells.length).toBeGreaterThan(0);
    for (const c of prov.cells) {
      if (c.suppressed) {
        expect(c.value).toBeNull();
        expect(c.value).not.toBe(0);
      } else {
        expect(typeof c.value).toBe("number");
      }
    }
  }, 30_000);

  it("locality cells keep k=5 suppression (suppressed cells carry no value)", async () => {
    const loc = await loadMortality(ADMIN, []);
    // Contract: any suppressed cell carries value=null and is counted in
    // suppressedCount; any visible cell carries a value >= 5 (k-anon, k=5).
    let suppressedSeen = 0;
    for (const cell of loc.cells) {
      if (cell.suppressed) {
        expect(cell.value).toBeNull();
        suppressedSeen += 1;
      } else {
        expect(cell.value ?? 0).toBeGreaterThanOrEqual(5);
      }
    }
    expect(loc.suppressedCount).toBe(suppressedSeen);
  }, 30_000);
});

describe("U5 loadChoroplethByLevel overload routing", () => {
  // PRE-PUSH REVIEW 2026-07-30: this used to assert the province envelope had NO
  // suppressedCount. Province cells ARE suppressible (#40 — k protects the
  // DENOMINATOR), so an absent count meant a hatched province map disclosed
  // nothing. The field is now REQUIRED and must agree with the cells.
  it("level='province' yields ProvinceChoroplethRows (suppressedCount agrees with the cells, code cells)", async () => {
    const rows = await loadChoroplethByLevel("mortality", "province", ADMIN, []);
    expect(rows).toHaveProperty("suppressedCount");
    expect(rows.suppressedCount).toBe(rows.cells.filter((c) => c.suppressed).length);
    expect(rows.cells.every((c) => "provinceCode" in c)).toBe(true);
  }, 30_000);

  it("level='locality' yields ChoroplethRows (suppressedCount, centroid cells)", async () => {
    const rows = await loadChoroplethByLevel("mortality", "locality", ADMIN, []);
    expect(rows).toHaveProperty("suppressedCount");
    expect(rows.cells.every((c) => "centroidLat" in c)).toBe(true);
  }, 30_000);

  it("province routing agrees with the direct loader for the same metric", async () => {
    const [viaLevel, direct] = await Promise.all([
      loadChoroplethByLevel("mortality", "province", ADMIN, []),
      loadMortalityByProvince(ADMIN, []),
    ]);
    // Same metric + level + scope → identical province totals.
    const a = new Map(viaLevel.cells.map((c) => [c.provinceCode, c.value]));
    const b = new Map(direct.cells.map((c) => [c.provinceCode, c.value]));
    expect(a).toEqual(b);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// U5 — microchip-penetration + ppp-compliance metric enumeration (panorama-
// operator-ia port). Both are RATE metrics with the SAME v1 shape contract as
// rabies-coverage/sterilization-coverage: province emits ratePct (via the
// canonical compliance-metrics ByProvince fetchers), locality emits
// count-density AND carries noLocalityCount (the stash's equivalent loaders
// omitted this field — the regression this suite guards against).
// ---------------------------------------------------------------------------

describe("U5 metric enumeration — microchip-penetration + ppp-compliance", () => {
  it.each(["microchip-penetration", "ppp-compliance"] as const)(
    "%s: province level returns ProvinceChoroplethRows (suppressedCount, valid codes)",
    async (metric) => {
      const rows = await loadChoroplethByLevel(metric, "province", ADMIN, []);
      // The withheld-cell count is REQUIRED at province grain and must equal what
      // the map hatches — a fully-suppressed layer that reported 0 left the
      // all-suppressed notice and the LayerPanel footer silent.
      expect(rows.suppressedCount).toBe(rows.cells.filter((x) => x.suppressed).length);
      for (const c of rows.cells) {
        expect(VALID_CODES.has(c.provinceCode)).toBe(true);
        // #40: ppp-compliance carries the SMALLEST denominator on the board
        // (PPP-flagged pets are a rare subset), so this is the layer where
        // province suppression actually fires on the seed data.
        expect(c.suppressed ? c.value : typeof c.value).toBe(c.suppressed ? null : "number");
      }
    },
    30_000,
  );

  it.each(["microchip-penetration", "ppp-compliance"] as const)(
    "%s: locality level returns ChoroplethRows carrying noLocalityCount (U5 residual contract)",
    async (metric) => {
      const rows = await loadChoroplethByLevel(metric, "locality", ADMIN, []);
      expect(rows).toHaveProperty("suppressedCount");
      expect(rows).toHaveProperty("noLocalityCount");
      expect(typeof rows.noLocalityCount).toBe("number");
      for (const cell of rows.cells) {
        if (cell.suppressed) {
          expect(cell.value).toBeNull();
        } else {
          expect(cell.value ?? 0).toBeGreaterThanOrEqual(5);
        }
      }
    },
    30_000,
  );
});
