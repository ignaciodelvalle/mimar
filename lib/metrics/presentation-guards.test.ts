// Unit tests for lib/metrics/presentation-guards.ts — PURE, DB-free.
//
// Each describe block pins ONE red-team-verified dishonest-rendering class
// (dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md, C1) to the
// guard function that fences it.

import { describe, expect, it } from "vitest";

import type { KpiDefinition } from "./kpi-catalog";
import { KPI_CATALOG } from "./kpi-catalog";
import {
  DELTA_IMPLAUSIBLE_NOTE,
  DELTA_IMPLAUSIBLE_SUFFIX,
  UNSTABLE_DELTA_BASE_NOTE,
  ZERO_DENOMINATOR_DASH,
  applyCensusCoverageGuard,
  censusCoverageLowGate,
  censusCoverageWarningNote,
  deltaImplausibleGate,
  guardRatioTone,
  resolveSemaphoreTone,
  shouldSuppressDelta,
  smallNGate,
  smallNNote,
  zeroDenominatorGate,
} from "./presentation-guards";

type Descriptor = Pick<KpiDefinition, "guards" | "semaphore">;

const withZeroDenominatorGuard: Descriptor = { guards: { zeroDenominator: "dash" } };
const withSmallNGuard: Descriptor = { guards: { smallN: { min: 5 } } };
const withBothGuards: Descriptor = {
  guards: { zeroDenominator: "dash", smallN: { min: 5 } },
};
const withUnstableDeltaGuard: Descriptor = { guards: { unstableDeltaBase: { minPriorBase: 5 } } };
const noGuards: Descriptor = {};

describe("zeroDenominatorGate — the '0/0 → 0%' class", () => {
  it("fires when the guard is declared AND n is 0", () => {
    expect(zeroDenominatorGate(withZeroDenominatorGuard, 0)).toBe(true);
  });

  it("does not fire when n > 0", () => {
    expect(zeroDenominatorGate(withZeroDenominatorGuard, 1)).toBe(false);
  });

  it("does not fire when the descriptor has no zeroDenominator guard declared", () => {
    expect(zeroDenominatorGate(noGuards, 0)).toBe(false);
  });
});

describe("smallNGate — the '100% con N=2' class", () => {
  it("fires for a positive n strictly below `min`", () => {
    expect(smallNGate(withSmallNGuard, 2)).toBe(true);
  });

  it("does not fire at or above `min`", () => {
    expect(smallNGate(withSmallNGuard, 5)).toBe(false);
    expect(smallNGate(withSmallNGuard, 10)).toBe(false);
  });

  it("does not fire at n=0 — that is the zero-denominator state, not a small sample", () => {
    expect(smallNGate(withSmallNGuard, 0)).toBe(false);
  });

  it("does not fire when the descriptor has no smallN guard declared", () => {
    expect(smallNGate(noGuards, 2)).toBe(false);
  });
});

describe("guardRatioTone — composed value/tone/note for a rate tile", () => {
  // C8/U1, reproduced live on /gob/vigilancia 2026-07-27: the rabies-10d tile
  // rendered a neutral "—" while a red banner two centimetres below shouted
  // "4 observaciones rábicas fuera del plazo legal", and the sibling ENO tile
  // said "3 vencidas ahora". The tile had already swapped its headline to the
  // live breach count (rabiesComplianceHeadline) — and then the zero-
  // denominator gate, reading `closed === 0`, threw that away.
  //
  // The gate is right about ratios and wrong about this: a live count has no
  // denominator to be empty. `valueIsRatio: false` is how a caller says the
  // headline is no longer the rate.
  it("does NOT dash a live breach headline just because the ratio's denominator is 0", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 0,
      computedTone: "danger",
      formattedValue: "4 fuera de plazo ahora",
      valueIsRatio: false,
    });
    expect(result).toEqual({ value: "4 fuera de plazo ahora", tone: "danger" });
  });

  it("does not apply the small-N note either when the value is not a ratio", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 2,
      computedTone: "danger",
      formattedValue: "2 fuera de plazo ahora",
      valueIsRatio: false,
    });
    expect(result).toEqual({ value: "2 fuera de plazo ahora", tone: "danger" });
  });

  it("still dashes when the value IS the ratio — the guard's actual job", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 0,
      computedTone: "danger",
      formattedValue: "0,0%",
      valueIsRatio: true,
    });
    expect(result).toEqual({ value: ZERO_DENOMINATOR_DASH, tone: "neutral" });
  });

  it("n=0 with the zero-denominator guard renders the dash, neutral tone, no note", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 0,
      computedTone: "danger",
      formattedValue: "0,0%",
    });
    expect(result).toEqual({ value: ZERO_DENOMINATOR_DASH, tone: "neutral" });
  });

  it("small N (reunificación 100% · 2 de 2) keeps the real value, forces neutral, adds a note", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 2,
      computedTone: "ok",
      formattedValue: "100,0%",
    });
    expect(result.value).toBe("100,0%");
    expect(result.tone).toBe("neutral");
    expect(result.note).toBe(smallNNote(5));
  });

  it("n at/above the smallN floor passes the computed tone through unchanged", () => {
    const result = guardRatioTone(withBothGuards, {
      n: 68,
      computedTone: "ok",
      formattedValue: "41,3%",
    });
    expect(result).toEqual({ value: "41,3%", tone: "ok" });
  });

  it("a descriptor with no guards at all is a no-op passthrough", () => {
    const result = guardRatioTone(noGuards, {
      n: 1,
      computedTone: "danger",
      formattedValue: "5,0%",
    });
    expect(result).toEqual({ value: "5,0%", tone: "danger" });
  });
});

describe("shouldSuppressDelta — the '−95% MoM sobre base inestable' class", () => {
  it("suppresses when the prior base is below the floor", () => {
    expect(shouldSuppressDelta(withUnstableDeltaGuard, 1)).toBe(true);
  });

  it("does not suppress at or above the floor", () => {
    expect(shouldSuppressDelta(withUnstableDeltaGuard, 5)).toBe(false);
    expect(shouldSuppressDelta(withUnstableDeltaGuard, 20)).toBe(false);
  });

  it("does not suppress when the descriptor declares no unstableDeltaBase guard", () => {
    expect(shouldSuppressDelta(noGuards, 0)).toBe(false);
  });

  it("exposes a stable, non-empty note for the suppressed state", () => {
    expect(UNSTABLE_DELTA_BASE_NOTE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// deltaImplausibleGate — H16 (external red-team 2026-07-30).
//
// WHAT THE CODE DID BEFORE THIS BLOCK EXISTED: /gob rendered
// "Esterilizaciones / mes: 1 ↓ −99,6% vs mes anterior (desde 274)" with the
// same red arrow a genuine collapse gets. shouldSuppressDelta above could not
// help — its floor is 5 and the prior base was 274, so by that guard's
// reckoning the delta was perfectly trustworthy. There was no assertion
// anywhere that a −99,6% over a healthy base must not read as a fact; this
// block is that assertion.
// ---------------------------------------------------------------------------

describe("deltaImplausibleGate — the '−99,6% sobre una base sana' class", () => {
  const withImplausibleGuard: Descriptor = {
    guards: { deltaImplausible: { minFoldChange: 10, minPriorBase: 50 } },
  };

  it("fires on the exact figure that shipped: −99,6% over a prior base of 274", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -99.6, priorBase: 274 })).toBe(
      true,
    );
  });

  // The downside boundary sits BETWEEN these two, and that is all this pair
  // can honestly claim: Δ = −90% computes to a ratio of 0.09999999999999998,
  // so no input lands exactly on ×0,1 and no test can distinguish a strict
  // from a non-strict comparison there (mutation testing, 2026-07-30). The
  // operator itself is pinned by the +900% case below, which the
  // implementation now shares with this one.
  it("fires at an order-of-magnitude drop — −90% is ×0,1", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -90, priorBase: 274 })).toBe(
      true,
    );
  });

  it("leaves a steep but sub-order-of-magnitude drop alone — −89% keeps its verdict", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -89, priorBase: 274 })).toBe(
      false,
    );
  });

  it("treats an impossible delta below −100% as implausible, not as a mild drop", () => {
    // Only reachable from corrupt input; folding it to a finite magnitude
    // would let it slip past the threshold and render a confident verdict.
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -100, priorBase: 274 })).toBe(
      true,
    );
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -150, priorBase: 274 })).toBe(
      true,
    );
  });

  // THE reason the rule is a fold change and not |Δ%| ≥ 90. A raw absolute
  // threshold treats ×0,1 and ×1,9 as the same magnitude, so it would flag a
  // campaign month that legitimately nearly doubled — and a guard that fires
  // on ordinary programme behaviour is a guard operators learn to ignore.
  it("does NOT flag a legitimate near-doubling: +95% is ×1,95, not an order of magnitude", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: 95, priorBase: 274 })).toBe(
      false,
    );
  });

  it("fires on the UPSIDE mirror instead — +900% is ×10, the bulk-backload signature", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: 900, priorBase: 274 })).toBe(
      true,
    );
  });

  it("fires exactly AT the prior-base floor (50), not one event above it", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -99.6, priorBase: 50 })).toBe(
      true,
    );
  });

  it("stays silent below the prior-base floor — a 49-event month that stops has ordinary causes", () => {
    expect(deltaImplausibleGate(withImplausibleGuard, { deltaPct: -99.6, priorBase: 49 })).toBe(
      false,
    );
  });

  it("does not fire when the descriptor declares no deltaImplausible guard", () => {
    expect(deltaImplausibleGate(noGuards, { deltaPct: -99.6, priorBase: 274 })).toBe(false);
  });

  it("does not fire on a non-finite delta", () => {
    // NaN alone would be a weak assertion — every comparison against NaN is
    // already false, so it holds with or without the finiteness check.
    // Infinity is the case that actually needs it: ∞ >= 10 is true, so without
    // the guard a garbage input would render as a confident "verificar carga"
    // on a tile whose delta could not be computed at all.
    expect(
      deltaImplausibleGate(withImplausibleGuard, { deltaPct: Number.NaN, priorBase: 274 }),
    ).toBe(false);
    expect(
      deltaImplausibleGate(withImplausibleGuard, {
        deltaPct: Number.POSITIVE_INFINITY,
        priorBase: 274,
      }),
    ).toBe(false);
  });

  it("the shipped sterilization descriptor carries the guard, wired to the live numbers", () => {
    expect(
      deltaImplausibleGate(KPI_CATALOG.sterilizations_per_month, {
        deltaPct: -99.6,
        priorBase: 274,
      }),
    ).toBe(true);
  });

  it("exposes a stable, non-empty note and chip suffix for the flagged state", () => {
    expect(DELTA_IMPLAUSIBLE_NOTE.length).toBeGreaterThan(0);
    expect(DELTA_IMPLAUSIBLE_SUFFIX.length).toBeGreaterThan(0);
    // The copy must read as an instruction to check, never as a verdict that
    // the number is wrong — the guard cannot know which it is.
    expect(DELTA_IMPLAUSIBLE_NOTE).toContain("Verificá la carga");
  });
});

describe("resolveSemaphoreTone — the 'semáforo como veredicto legal' class", () => {
  it("paintAgainst 'none' NEVER returns the computed judgment tone — even 'danger'", () => {
    const descriptor: Descriptor = { semaphore: { paintAgainst: "none" } };
    expect(resolveSemaphoreTone(descriptor, "danger")).not.toBe("danger");
    expect(resolveSemaphoreTone(descriptor, "danger")).toBe("blue");
  });

  it("paintAgainst 'none' respects a caller-supplied fallback tone", () => {
    const descriptor: Descriptor = { semaphore: { paintAgainst: "none" } };
    expect(resolveSemaphoreTone(descriptor, "ok", "neutral")).toBe("neutral");
  });

  it("paintAgainst 'target' passes the computed tone through unchanged", () => {
    const descriptor: Descriptor = { semaphore: { paintAgainst: "target" } };
    expect(resolveSemaphoreTone(descriptor, "danger")).toBe("danger");
    expect(resolveSemaphoreTone(descriptor, "ok")).toBe("ok");
  });

  it("an absent semaphore policy (uncatalogued/legacy KPI) is backward-compat passthrough", () => {
    expect(resolveSemaphoreTone(noGuards, "warn")).toBe("warn");
  });
});

// Cursor red-team 2026-07-23 (claim #1) — "dual-denominator hero" class: a
// registry-coverage rate can read a confident % while the padrón it's
// computed over covers a sliver of the census-estimated population.
describe("censusCoverageLowGate / applyCensusCoverageGuard — the 'dual-denominator hero' class", () => {
  const withFloor: Descriptor = { guards: { censusCoverageFloor: 20 } };

  it("fires when the floor is declared AND censusCoveragePct is below it", () => {
    expect(censusCoverageLowGate(withFloor, 0.4)).toBe(true);
  });

  it("does not fire when censusCoveragePct meets or beats the floor", () => {
    expect(censusCoverageLowGate(withFloor, 20)).toBe(false);
    expect(censusCoverageLowGate(withFloor, 55)).toBe(false);
  });

  it("does not fire when there is no census estimate at all (null — a DIFFERENT 'sin estimación' state)", () => {
    expect(censusCoverageLowGate(withFloor, null)).toBe(false);
  });

  it("does not fire when the descriptor declares no censusCoverageFloor", () => {
    expect(censusCoverageLowGate(noGuards, 0.4)).toBe(false);
  });

  it("applyCensusCoverageGuard forces neutral tone + a note when the gate fires — never silently", () => {
    const result = applyCensusCoverageGuard(withFloor, {
      censusCoveragePct: 0.4,
      computedTone: "ok",
    });
    expect(result.tone).toBe("neutral");
    expect(result.note).toBe(censusCoverageWarningNote(0.4));
    expect(result.note).toContain("NO representa protección poblacional");
  });

  it("applyCensusCoverageGuard passes the computed tone through unchanged when the gate does not fire", () => {
    const result = applyCensusCoverageGuard(withFloor, {
      censusCoveragePct: 55,
      computedTone: "warn",
    });
    expect(result).toEqual({ tone: "warn" });
  });
});
