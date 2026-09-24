import { describe, expect, it } from "vitest";

import {
  type RankingAvailabilityInput,
  rankingAvailability,
  shouldHideStructure,
} from "@/src/modules/panorama/domain/data-availability";

const base: RankingAvailabilityInput = {
  rowCount: 0,
  measuredUnits: 0,
  suppressedUnits: 0,
  calculationFailed: false,
};

describe("rankingAvailability — P2-1 (absent vs suppressed)", () => {
  it("rows to print → data", () => {
    expect(rankingAvailability({ ...base, rowCount: 4, measuredUnits: 12 })).toBe("data");
  });

  it("nothing measured, nothing withheld, nothing broken → absent (P2 hides it)", () => {
    expect(rankingAvailability(base)).toBe("absent");
    expect(shouldHideStructure(rankingAvailability(base))).toBe(true);
  });

  it("no rankable layer in the active view → absent", () => {
    expect(rankingAvailability({ ...base, noRankableLayer: true })).toBe("absent");
  });

  it("k-anon withheld every value → suppressed, NEVER hidden", () => {
    const state = rankingAvailability({ ...base, suppressedUnits: 3 });
    expect(state).toBe("suppressed");
    expect(shouldHideStructure(state)).toBe(false);
  });

  it("suppression outranks 'no rankable layer' — a withheld value may never vanish in silence", () => {
    expect(rankingAvailability({ ...base, suppressedUnits: 2, noRankableLayer: true })).toBe(
      "suppressed",
    );
  });

  it("a MEASURED all-clear is a result, not an empty → data", () => {
    // Mortalidad-style: 20 units measured, none below target. Zero rows, but the
    // "ninguna quedó bajo meta" line is backed by measurement — it must show.
    expect(rankingAvailability({ ...base, measuredUnits: 20 })).toBe("data");
  });

  it("a FAILED calculation is declared, not hidden (2026-07-10 honesty invariant)", () => {
    const state = rankingAvailability({ ...base, calculationFailed: true });
    expect(state).toBe("data");
    expect(shouldHideStructure(state)).toBe(false);
  });

  it("rows present alongside suppressed units still render the table", () => {
    // The suppressed-count line renders beside the table; the table is not hidden.
    expect(rankingAvailability({ ...base, rowCount: 10, suppressedUnits: 5 })).toBe("data");
  });
});
