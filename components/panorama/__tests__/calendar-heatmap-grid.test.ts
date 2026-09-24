// Tests for the CalendarHeatmap grid math (viz-suite Wave 1, item 1).

import { describe, expect, it } from "vitest";

import {
  MONTHS_LONG_ES,
  WEEKDAY_INITIALS_MON,
  buildCalendarGrid,
  cellAriaLabel,
  clampSinceToRecentMonths,
  intensityLevel,
} from "@/components/panorama/calendar-heatmap-grid";

describe("intensityLevel — monotonic sequential bucketing", () => {
  it("maps zero to level 0 and the window max to level 4", () => {
    expect(intensityLevel(0, 10)).toBe(0);
    expect(intensityLevel(10, 10)).toBe(4);
  });

  it("buckets by quartiles of the window max", () => {
    expect(intensityLevel(1, 4)).toBe(1);
    expect(intensityLevel(2, 4)).toBe(2);
    expect(intensityLevel(3, 4)).toBe(3);
    expect(intensityLevel(4, 4)).toBe(4);
  });

  it("is non-decreasing in count (never inverts the intensity read)", () => {
    const max = 17;
    let prev = -1;
    for (let c = 0; c <= max; c++) {
      const lvl = intensityLevel(c, max);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it("returns 0 for a degenerate max", () => {
    expect(intensityLevel(3, 0)).toBe(0);
  });
});

describe("buildCalendarGrid — window → columns", () => {
  it("packs two whole Monday–Sunday weeks into two full columns", () => {
    // 2026-01-05 is a Monday; 2026-01-18 is the second Sunday → 14 days.
    const grid = buildCalendarGrid({ since: "2026-01-05", until: "2026-01-18", counts: [] });
    expect(grid.columns).toHaveLength(2);
    expect(grid.dayCount).toBe(14);
    // No absent padding: every slot is an in-window day.
    for (const col of grid.columns) {
      expect(col.cells).toHaveLength(7);
      expect(col.cells.every((c) => c !== null)).toBe(true);
    }
    expect(grid.weekdayLabels).toEqual([...WEEKDAY_INITIALS_MON]);
  });

  it("renders out-of-window days as ABSENT (null) and in-window empty days as ZERO", () => {
    // Wed 2026-01-07 → Tue 2026-01-13 (7 days across two ragged weeks).
    const grid = buildCalendarGrid({
      since: "2026-01-07",
      until: "2026-01-13",
      counts: [{ date: "2026-01-07", count: 5 }], // only one day carries events
    });
    expect(grid.columns).toHaveLength(2);

    // Column 0: Mon+Tue slots are before the window → ABSENT (null), not zero.
    const col0 = grid.columns[0];
    expect(col0.cells[0]).toBeNull();
    expect(col0.cells[1]).toBeNull();
    expect(col0.cells[2]?.date).toBe("2026-01-07");

    // Column 1: Mon+Tue are in-window; Wed..Sun are after the window → ABSENT.
    const col1 = grid.columns[1];
    expect(col1.cells[0]?.date).toBe("2026-01-12");
    expect(col1.cells[1]?.date).toBe("2026-01-13");
    for (let r = 2; r < 7; r++) expect(col1.cells[r]).toBeNull();

    // An in-window day with no matching count is ZERO (present, level 0), NOT absent.
    const jan8 = grid.columns[0].cells[3];
    expect(jan8?.date).toBe("2026-01-08");
    expect(jan8?.count).toBe(0);
    expect(jan8?.level).toBe(0);
  });

  it("derives intensity from the window's own max", () => {
    const grid = buildCalendarGrid({
      since: "2026-01-05",
      until: "2026-01-11", // one Monday–Sunday week
      counts: [
        { date: "2026-01-05", count: 8 }, // the max → level 4
        { date: "2026-01-06", count: 2 }, // 2/8 = 0.25 → level 1
        { date: "2026-01-07", count: 4 }, // 4/8 = 0.5 → level 2
      ],
    });
    expect(grid.max).toBe(8);
    expect(grid.total).toBe(14);
    const [mon, tue, wed] = grid.columns[0].cells;
    expect(mon?.level).toBe(4);
    expect(tue?.level).toBe(1);
    expect(wed?.level).toBe(2);
  });

  it("labels the column where each month first appears (es-AR short names)", () => {
    const grid = buildCalendarGrid({ since: "2026-01-26", until: "2026-02-15", counts: [] });
    const labels = grid.columns.map((c) => c.monthLabel).filter((l): l is string => l !== null);
    expect(labels).toContain("ene");
    expect(labels).toContain("feb");
  });

  it("returns an empty grid for an inverted or malformed window", () => {
    expect(
      buildCalendarGrid({ since: "2026-02-01", until: "2026-01-01", counts: [] }).columns,
    ).toEqual([]);
    expect(buildCalendarGrid({ since: "nope", until: "2026-01-01", counts: [] }).columns).toEqual(
      [],
    );
  });

  it("folds duplicate per-day entries (merged multi-layer counts) into one cell", () => {
    const grid = buildCalendarGrid({
      since: "2026-01-05",
      until: "2026-01-05",
      counts: [
        { date: "2026-01-05", count: 3 },
        { date: "2026-01-05", count: 4 },
      ],
    });
    expect(grid.columns[0].cells.find((c) => c?.date === "2026-01-05")?.count).toBe(7);
  });

  it("supports Sunday-first weeks", () => {
    // 2026-01-04 is a Sunday.
    const grid = buildCalendarGrid({
      since: "2026-01-04",
      until: "2026-01-10",
      counts: [],
      weekStartsOn: 0,
    });
    expect(grid.columns).toHaveLength(1);
    expect(grid.columns[0].cells[0]?.date).toBe("2026-01-04"); // Sunday at row 0
  });
});

describe("clampSinceToRecentMonths — 12-month cap boundary (PO 2026-07-14)", () => {
  it("leaves a window SHORTER than the cap unchanged", () => {
    expect(clampSinceToRecentMonths("2026-01-01", "2026-07-14", 12)).toEqual({
      since: "2026-01-01",
      capped: false,
    });
  });

  it("does NOT cap a window spanning EXACTLY 12 months (since === cutoff)", () => {
    // until 2026-07-14 → cutoff = same day one year earlier.
    expect(clampSinceToRecentMonths("2025-07-14", "2026-07-14", 12)).toEqual({
      since: "2025-07-14",
      capped: false,
    });
  });

  it("caps a window one day past the boundary, clamping since to the cutoff", () => {
    expect(clampSinceToRecentMonths("2025-07-13", "2026-07-14", 12)).toEqual({
      since: "2025-07-14",
      capped: true,
    });
  });

  it("caps a multi-year window to the most recent 12 months", () => {
    expect(clampSinceToRecentMonths("2023-03-01", "2026-07-14", 12)).toEqual({
      since: "2025-07-14",
      capped: true,
    });
  });

  it("returns the window unchanged for a malformed or inverted range", () => {
    expect(clampSinceToRecentMonths("2026-02-01", "2026-01-01", 12)).toEqual({
      since: "2026-02-01",
      capped: false,
    });
    expect(clampSinceToRecentMonths("nope", "2026-01-01", 12)).toEqual({
      since: "nope",
      capped: false,
    });
  });

  it("the clamped since drives a ~12-month buildCalendarGrid span", () => {
    const { since, capped } = clampSinceToRecentMonths("2020-01-01", "2026-07-14", 12);
    expect(capped).toBe(true);
    const grid = buildCalendarGrid({ since, until: "2026-07-14", counts: [] });
    // 12 months ≈ 365–366 days; assert it is neither the multi-year original
    // nor collapsed to nothing.
    expect(grid.dayCount).toBeGreaterThan(360);
    expect(grid.dayCount).toBeLessThan(372);
  });
});

describe("cellAriaLabel — es-AR per-day accessible name", () => {
  it('reads "D de MMMM: N eventos" with singular/plural agreement', () => {
    const grid = buildCalendarGrid({
      since: "2026-07-07",
      until: "2026-07-07",
      counts: [{ date: "2026-07-07", count: 1 }],
    });
    const cell = grid.columns[0].cells.find((c) => c?.date === "2026-07-07");
    if (!cell) throw new Error("expected the 2026-07-07 cell");
    expect(MONTHS_LONG_ES[cell.monthIndex]).toBe("julio");
    expect(cellAriaLabel(cell)).toBe("7 de julio: 1 evento");

    const zeroDay = buildCalendarGrid({
      since: "2026-07-08",
      until: "2026-07-08",
      counts: [],
    }).columns[0].cells.find((c) => c?.date === "2026-07-08");
    if (!zeroDay) throw new Error("expected the 2026-07-08 cell");
    expect(cellAriaLabel(zeroDay)).toBe("8 de julio: 0 eventos");
  });
});
