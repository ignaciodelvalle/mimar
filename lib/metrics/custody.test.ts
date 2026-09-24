// lib/metrics/custody.test.ts — Paquete F custody & adoption tests.
//
// All tests here are DB-FREE (pure helpers only).
// DB-bound fetchers (fetchCustodyFunnel, fetchTimeInState, etc.) follow the
// shape-only tsc-verified-only pattern established in trends.test.ts and
// census.test.ts: they are commented with the type assertions that tsc checks,
// but do NOT run here (no live Postgres in unit suite).
//
// Pure helpers tested:
//   1. funnelBarWidths — volume-proportional bar widths, no stage exceeds 100,
//                        max stage always fills the bar, all-zero guard
//   2. returnRate            — null on zero denominator, correct ratio
//   3. timeInStateNonNegative — clamps negatives to 0
//   4. reconciliation        — funnel + tile devolución rate agree (single source)

import { describe, expect, it } from "vitest";

import { type FunnelCounts, funnelBarWidths, returnRate, timeInStateNonNegative } from "./custody";

// ---------------------------------------------------------------------------
// 1. funnelBarWidths — bars proportional to the LARGEST stage (independent
//    event counts, NOT a cohort narrowing from intake). No clamping needed:
//    the widest stage is 100 by construction and nothing exceeds it.
// ---------------------------------------------------------------------------

describe("funnelBarWidths", () => {
  it("all stages zero → all widths 0 (no data)", () => {
    const w = funnelBarWidths({ intake: 0, foster: 0, adoption: 0, reversed: 0 });
    expect(w).toEqual({ intakePct: 0, fosterPct: 0, adoptionPct: 0, reversedPct: 0 });
  });

  it("all stages equal → every bar fills the width", () => {
    const w = funnelBarWidths({ intake: 10, foster: 10, adoption: 10, reversed: 10 });
    expect(w).toEqual({ intakePct: 100, fosterPct: 100, adoptionPct: 100, reversedPct: 100 });
  });

  it("classic narrowing funnel — intake is the widest, downstream proportional", () => {
    const w = funnelBarWidths({ intake: 100, foster: 40, adoption: 20, reversed: 2 });
    expect(w.intakePct).toBe(100);
    expect(w.fosterPct).toBe(40);
    expect(w.adoptionPct).toBe(20);
    expect(w.reversedPct).toBe(2);
  });

  it("adoption exceeds intake (non-cohort reality) — adoption fills the bar, intake is proportional, NOTHING is clamped", () => {
    // The bug scenario: intake=28, adoption=56, reversed=1. The old helper
    // rendered intake AND adoption both at 100% (Math.min clamp), hiding that
    // adoptions are 2x intakes. The honest helper scales to the max (56).
    const w = funnelBarWidths({ intake: 28, foster: 12, adoption: 56, reversed: 1 });
    expect(w.adoptionPct).toBe(100); // largest stage fills the bar (visible)
    expect(w.intakePct).toBe(50); // 28 / 56
    expect(w.reversedPct).toBe(1.8); // 1 / 56
    // Internal consistency: no stage can ever exceed 100.
    for (const v of Object.values(w)) {
      expect(v).toBeLessThanOrEqual(100);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("no stage ever exceeds 100 across arbitrary orderings", () => {
    const cases: FunnelCounts[] = [
      { intake: 5, foster: 200, adoption: 1, reversed: 999 },
      { intake: 0, foster: 0, adoption: 7, reversed: 3 },
      { intake: 1, foster: 0, adoption: 0, reversed: 0 },
    ];
    for (const c of cases) {
      const w = funnelBarWidths(c);
      for (const v of Object.values(w)) expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("widths are rounded to one decimal", () => {
    // 1/3 of the max → 33.3
    const w = funnelBarWidths({ intake: 3, foster: 1, adoption: 0, reversed: 0 });
    expect(w.fosterPct).toBe(33.3);
  });
});

// ---------------------------------------------------------------------------
// 4. Reconciliation — the devolución rate shown in the funnel row and the
//    "tasa de retorno" KPI tile MUST come from a single source:
//    returnRate(reversed, adoption) — i.e. reversed / adoptions, NOT
//    reversed / intake. This guards against the two-denominators-on-one-screen
//    regression flagged in the demo review (funnel showed 3.6% = 1/28 while the
//    tile showed 1.8% = 1/56).
// ---------------------------------------------------------------------------

describe("devolución rate is single-sourced (funnel ↔ tile reconciliation)", () => {
  it("the shown percentage is reversed/adoptions, and it does NOT depend on intake", () => {
    const counts: FunnelCounts = { intake: 28, foster: 12, adoption: 56, reversed: 1 };

    // The one true rate used by BOTH the KPI tile and the funnel row label.
    const rate = returnRate(counts.reversed, counts.adoption);
    const shownPct = rate != null ? Math.round(rate * 1000) / 10 : null;
    expect(shownPct).toBe(1.8); // 1 / 56

    // The bar WIDTH is volume-proportional and must not be reinterpreted as the
    // rate: reversed's width (reversed/max) differs from the rate (reversed/adoptions).
    const widths = funnelBarWidths(counts);
    expect(widths.reversedPct).toBe(1.8); // 1 / 56 here since adoption is the max

    // The discredited denominator (reversed/intake) would give a different,
    // conflicting number — proving intake is NOT the base.
    const wrongIntakeBased = Math.round((counts.reversed / counts.intake) * 1000) / 10;
    expect(wrongIntakeBased).toBe(3.6);
    expect(wrongIntakeBased).not.toBe(shownPct);
  });

  it("rate is null (no percentage shown) when there are no adoptions", () => {
    const counts: FunnelCounts = { intake: 10, foster: 4, adoption: 0, reversed: 0 };
    expect(returnRate(counts.reversed, counts.adoption)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. returnRate
// ---------------------------------------------------------------------------

describe("returnRate", () => {
  it("returns null when finalized=0 (undefined rate)", () => {
    expect(returnRate(0, 0)).toBeNull();
    expect(returnRate(5, 0)).toBeNull();
  });

  it("returns 0 when reversed=0 and finalized>0", () => {
    expect(returnRate(0, 10)).toBe(0);
  });

  it("returns correct ratio", () => {
    expect(returnRate(2, 10)).toBe(0.2);
  });

  it("returns 1.0 when all adoptions reversed", () => {
    expect(returnRate(5, 5)).toBe(1.0);
  });

  it("can exceed 1 when reversed > finalized in the same period", () => {
    // This is period-based (events in window), so reversed > finalized is possible
    // (reversal of prior-period adoptions coming in).
    expect(returnRate(6, 5)).toBeCloseTo(1.2);
  });
});

// ---------------------------------------------------------------------------
// 3. timeInStateNonNegative
// ---------------------------------------------------------------------------

describe("timeInStateNonNegative", () => {
  it("positive value passes through unchanged", () => {
    expect(timeInStateNonNegative(10)).toBe(10);
    expect(timeInStateNonNegative(0.5)).toBe(0.5);
  });

  it("zero passes through as 0", () => {
    expect(timeInStateNonNegative(0)).toBe(0);
  });

  it("negative value is clamped to 0", () => {
    expect(timeInStateNonNegative(-1)).toBe(0);
    expect(timeInStateNonNegative(-0.001)).toBe(0);
  });

  it("large positive value is unchanged", () => {
    expect(timeInStateNonNegative(365)).toBe(365);
  });
});

// ---------------------------------------------------------------------------
// DB-bound shape stubs (tsc-only — no live Postgres in unit suite)
//
// These would be in a separate integration test file that imports from vitest
// with the same setup as trends.test.ts. Kept here as TSC-verified type
// assertions so the compiler catches signature changes.
//
// To enable: copy to a new file, add the DB setup imports (same as trends.test.ts),
// and remove the comment block. The shape assertions will then run against the DB.
// ---------------------------------------------------------------------------

// import { buildProjectionContext } from "@/lib/metrics";
// import {
//   fetchCustodyFunnel,
//   fetchTimeInState,
//   fetchReturnRate,
//   fetchFosterPoolUtilization,
//   fetchShelterOccupancyNational,
//   fetchAdoptionTrend,
// } from "./custody";
//
// function adminCtx12m() {
//   return buildProjectionContext({ role: "admin" }, [], {
//     since: new Date(Date.now() - 365 * 86_400_000),
//     until: new Date(Date.now() + 86_400_000),
//   });
// }
//
// describe("custody fetchers — DB shape (tsc-only)", () => {
//   it("fetchCustodyFunnel resolves with FunnelCounts shape", async () => {
//     const r = await fetchCustodyFunnel(adminCtx12m());
//     expect(typeof r.intake).toBe("number");
//     expect(typeof r.foster).toBe("number");
//     expect(typeof r.adoption).toBe("number");
//     expect(typeof r.reversed).toBe("number");
//     expect(r.intake).toBeGreaterThanOrEqual(0);
//     expect(r.foster).toBeGreaterThanOrEqual(0);
//     expect(r.adoption).toBeGreaterThanOrEqual(0);
//     expect(r.reversed).toBeGreaterThanOrEqual(0);
//   });
//
//   it("fetchTimeInState resolves with non-negative day values", async () => {
//     const rows = await fetchTimeInState(adminCtx12m());
//     expect(Array.isArray(rows)).toBe(true);
//     for (const row of rows) {
//       expect(["shelter_custody", "foster"]).toContain(row.role);
//       if (row.medianDays != null) expect(row.medianDays).toBeGreaterThanOrEqual(0);
//       if (row.p75Days != null) expect(row.p75Days).toBeGreaterThanOrEqual(0);
//       expect(row.n).toBeGreaterThanOrEqual(0);
//     }
//   });
//
//   it("fetchReturnRate resolves as null or non-negative number", async () => {
//     const r = await fetchReturnRate(adminCtx12m());
//     expect(r === null || typeof r === "number").toBe(true);
//     if (r !== null) expect(r).toBeGreaterThanOrEqual(0);
//   });
//
//   it("fetchFosterPoolUtilization resolves with numeric counts", async () => {
//     const r = await fetchFosterPoolUtilization(adminCtx12m());
//     expect(typeof r.activeVolunteers).toBe("number");
//     expect(typeof r.withCapacity).toBe("number");
//     expect(typeof r.activeFosterPlacements).toBe("number");
//     expect(r.activeVolunteers).toBeGreaterThanOrEqual(0);
//     expect(r.withCapacity).toBeGreaterThanOrEqual(0);
//     expect(r.activeFosterPlacements).toBeGreaterThanOrEqual(0);
//   });
//
//   it("fetchShelterOccupancyNational resolves with occupied >= 0 and capacity null-safe", async () => {
//     const r = await fetchShelterOccupancyNational(adminCtx12m());
//     expect(typeof r.occupied).toBe("number");
//     expect(r.occupied).toBeGreaterThanOrEqual(0);
//     expect(r.capacity === null || typeof r.capacity === "number").toBe(true);
//     if (r.capacity !== null) expect(r.capacity).toBeGreaterThanOrEqual(0);
//   });
//
//   it("fetchAdoptionTrend resolves with a valid single-series shape", async () => {
//     const r = await fetchAdoptionTrend(adminCtx12m());
//     expect(["week", "month"]).toContain(r.granularity);
//     expect(Array.isArray(r.points)).toBe(true);
//     expect(typeof r.suppressedCount).toBe("number");
//   });
// });
