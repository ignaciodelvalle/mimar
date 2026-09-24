// Unit tests for the F4 temporal-reproduction primitives (pure domain).
// No DB, no DOM — just date arithmetic over a fixed [since, until] window.

import { describe, expect, it } from "vitest";

import {
  buildScrubWindow,
  clampAsOf,
  dateToDayIndex,
  dayIndexToDate,
  formatAsOfDayLong,
  formatAsOfLabel,
  nextPlayIndex,
  parseAsOf,
} from "@/src/modules/panorama/domain/time-scrub";

const d = (iso: string) => new Date(iso);

describe("buildScrubWindow", () => {
  it("counts whole UTC days from start-of-since to until", () => {
    // 12-day cluster window (the Salta rabies demo moment).
    const win = buildScrubWindow(d("2026-06-01T09:30:00Z"), d("2026-06-13T18:00:00Z"));
    // since floored to 2026-06-01T00:00Z; until floored to 2026-06-13T00:00Z → 12 days.
    expect(win.steps).toBe(12);
    expect(win.since.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("collapses an inverted or single-instant window to zero steps", () => {
    expect(buildScrubWindow(d("2026-06-10T00:00:00Z"), d("2026-06-10T00:00:00Z")).steps).toBe(0);
    expect(buildScrubWindow(d("2026-06-10T00:00:00Z"), d("2026-06-01T00:00:00Z")).steps).toBe(0);
  });
});

describe("dayIndexToDate / dateToDayIndex", () => {
  const win = buildScrubWindow(d("2026-06-01T00:00:00Z"), d("2026-06-13T00:00:00Z"));

  it("maps index 0 to since and the last index to until", () => {
    expect(dayIndexToDate(win, 0).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(dayIndexToDate(win, win.steps).toISOString()).toBe(win.until.toISOString());
  });

  it("maps an interior index to since + n days", () => {
    expect(dayIndexToDate(win, 5).toISOString()).toBe("2026-06-06T00:00:00.000Z");
  });

  it("clamps out-of-range indices into [0, steps]", () => {
    expect(dayIndexToDate(win, -3).toISOString()).toBe(win.since.toISOString());
    expect(dayIndexToDate(win, 999).toISOString()).toBe(win.until.toISOString());
  });

  it("round-trips a date back to its index", () => {
    expect(dateToDayIndex(win, d("2026-06-06T00:00:00Z"))).toBe(5);
    expect(dateToDayIndex(win, d("2026-05-01T00:00:00Z"))).toBe(0); // clamped low
    expect(dateToDayIndex(win, d("2027-01-01T00:00:00Z"))).toBe(win.steps); // clamped high
  });
});

describe("nextPlayIndex", () => {
  const win = buildScrubWindow(d("2026-06-01T00:00:00Z"), d("2026-06-04T00:00:00Z")); // 3 steps

  it("advances one day per tick", () => {
    expect(nextPlayIndex(win, 0)).toBe(1);
    expect(nextPlayIndex(win, 1)).toBe(2);
  });

  it("returns null at the live edge so the loop stops", () => {
    expect(nextPlayIndex(win, win.steps)).toBeNull();
    expect(nextPlayIndex(win, 999)).toBeNull();
  });
});

describe("buildScrubWindow — long windows step by month", () => {
  it("steps by whole UTC months when the window exceeds ~90 days", () => {
    // A 3-year window: day stepping would be ~1095 steps (unusable). Month
    // stepping collapses it to 36 usable steps.
    const win = buildScrubWindow(d("2023-06-20T00:00:00Z"), d("2026-06-20T00:00:00Z"));
    expect(win.step).toBe("month");
    expect(win.steps).toBe(36);
    // `since` is floored to the START of its UTC month.
    expect(win.since.toISOString()).toBe("2023-06-01T00:00:00.000Z");
  });

  it("keeps day stepping at or below the ~90-day threshold", () => {
    const win = buildScrubWindow(d("2026-03-20T00:00:00Z"), d("2026-06-13T00:00:00Z")); // ~85 days
    expect(win.step).toBe("day");
  });

  it("maps a month-stepped index to since + n whole months", () => {
    const win = buildScrubWindow(d("2023-06-20T00:00:00Z"), d("2026-06-20T00:00:00Z"));
    expect(dayIndexToDate(win, 0).toISOString()).toBe("2023-06-01T00:00:00.000Z");
    expect(dayIndexToDate(win, 12).toISOString()).toBe("2024-06-01T00:00:00.000Z");
    // The final index is the live edge ("ahora") = until, unchanged.
    expect(dayIndexToDate(win, win.steps).toISOString()).toBe(win.until.toISOString());
  });

  it("round-trips a month-stepped date back to its month index", () => {
    const win = buildScrubWindow(d("2023-06-20T00:00:00Z"), d("2026-06-20T00:00:00Z"));
    expect(dateToDayIndex(win, d("2024-06-15T00:00:00Z"))).toBe(12);
    expect(dateToDayIndex(win, d("2020-01-01T00:00:00Z"))).toBe(0); // clamped low
    expect(dateToDayIndex(win, d("2030-01-01T00:00:00Z"))).toBe(win.steps); // clamped high
  });

  it("advances one month per play tick on a long window", () => {
    const win = buildScrubWindow(d("2023-06-20T00:00:00Z"), d("2026-06-20T00:00:00Z"));
    const next = nextPlayIndex(win, 0);
    expect(next).toBe(1);
    expect(dayIndexToDate(win, next as number).toISOString()).toBe("2023-07-01T00:00:00.000Z");
  });
});

describe("clampAsOf", () => {
  const since = d("2026-06-01T00:00:00Z");
  const until = d("2026-06-13T00:00:00Z");

  it("returns null for absent or invalid input (treated as live)", () => {
    expect(clampAsOf(null, since, until)).toBeNull();
    expect(clampAsOf(new Date("nope"), since, until)).toBeNull();
  });

  it("clamps below since up to since (cannot widen the window)", () => {
    expect(clampAsOf(d("2026-05-01T00:00:00Z"), since, until)?.toISOString()).toBe(
      since.toISOString(),
    );
  });

  it("clamps above until down to until (cannot exceed the live edge)", () => {
    expect(clampAsOf(d("2026-12-31T00:00:00Z"), since, until)?.toISOString()).toBe(
      until.toISOString(),
    );
  });

  it("passes an in-range as-of through unchanged", () => {
    const at = d("2026-06-06T12:00:00Z");
    expect(clampAsOf(at, since, until)?.toISOString()).toBe(at.toISOString());
  });
});

describe("parseAsOf", () => {
  it("parses a valid ISO string", () => {
    expect(parseAsOf("2026-06-06T00:00:00Z")?.toISOString()).toBe("2026-06-06T00:00:00.000Z");
  });
  it("returns null for absent or malformed input", () => {
    expect(parseAsOf(null)).toBeNull();
    expect(parseAsOf(undefined)).toBeNull();
    expect(parseAsOf("")).toBeNull();
    expect(parseAsOf("not-a-date")).toBeNull();
  });
});

describe("formatAsOfLabel", () => {
  it("renders a stable es-AR UTC day label", () => {
    const label = formatAsOfLabel(d("2026-06-06T15:00:00Z"));
    // Day matches the UTC date (06), not a local-tz shifted day.
    expect(label).toContain("06");
    expect(label).toContain("2026");
  });
});

describe("formatAsOfDayLong (T2.4 — the one as-of day shape)", () => {
  it("renders the long es-AR shape from a UTC day marker", () => {
    expect(formatAsOfDayLong(d("2026-05-08T00:00:00Z"))).toBe("8 de mayo de 2026");
  });

  it("never shifts to the previous day for a UTC-midnight marker (the T2.4 off-by-one)", () => {
    // An AR-timezone formatter (UTC-3) rendered 2026-05-08T00:00Z as "7 de
    // mayo" — the context bar disagreed with the dock over one URL. UTC in,
    // UTC out: the calendar day is the URL's day, always.
    expect(formatAsOfDayLong(d("2026-05-08T00:00:00Z"))).toContain("8 de mayo");
    expect(formatAsOfDayLong(d("2026-01-01T00:00:00Z"))).toBe("1 de enero de 2026");
  });
});
