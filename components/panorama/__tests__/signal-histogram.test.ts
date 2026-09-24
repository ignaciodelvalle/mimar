// Tests for the TimeScrubber signal-histogram binning (task #65).

import { describe, expect, it } from "vitest";

import {
  binDailyCounts,
  binTimestamps,
  dailyCountsFromTimestamps,
} from "@/components/panorama/signal-histogram";

const DAY = 86_400_000;
const since = Date.UTC(2026, 0, 1);
const until = since + 10 * DAY;

describe("binTimestamps", () => {
  it("counts events into equal-width bins over the window", () => {
    // Two events in the first tenth, one in the last tenth.
    const bins = binTimestamps(
      [
        new Date(since + 0.1 * DAY).toISOString(),
        new Date(since + 0.2 * DAY).toISOString(),
        new Date(since + 9.5 * DAY).toISOString(),
      ],
      since,
      until,
      10,
    );
    expect(bins).toHaveLength(10);
    expect(bins[0]).toBe(2);
    expect(bins[9]).toBe(1);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("accepts epoch millis as well as ISO strings", () => {
    const bins = binTimestamps([since + 5 * DAY], since, until, 10);
    expect(bins[5]).toBe(1);
  });

  it("skips unparseable timestamps", () => {
    const bins = binTimestamps(["not-a-date", ""], since, until, 10);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("returns an empty array for a degenerate window", () => {
    expect(binTimestamps([since], until, since, 10)).toEqual([]);
    expect(binTimestamps([since], since, until, 0)).toEqual([]);
  });
});

describe("binDailyCounts", () => {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("adds each day's count (weighted) into its bin over the window", () => {
    const bins = binDailyCounts(
      [
        { date: iso(since + 0.1 * DAY), count: 3 },
        { date: iso(since + 5 * DAY), count: 2 },
      ],
      since,
      until,
      10,
    );
    expect(bins).toHaveLength(10);
    expect(bins[0]).toBe(3);
    expect(bins[5]).toBe(2);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("clamps out-of-window days into the edge bins", () => {
    const bins = binDailyCounts(
      [
        { date: iso(since - 3 * DAY), count: 4 },
        { date: iso(until + 3 * DAY), count: 1 },
      ],
      since,
      until,
      10,
    );
    expect(bins[0]).toBe(4);
    expect(bins[9]).toBe(1);
  });

  it("skips unparseable dates and non-positive counts", () => {
    const bins = binDailyCounts(
      [
        { date: "not-a-date", count: 5 },
        { date: iso(since + 2 * DAY), count: 0 },
        { date: iso(since + 2 * DAY), count: -3 },
      ],
      since,
      until,
      10,
    );
    expect(bins.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("returns an empty array for a degenerate window or bin count", () => {
    expect(binDailyCounts([{ date: iso(since), count: 1 }], until, since, 10)).toEqual([]);
    expect(binDailyCounts([{ date: iso(since), count: 1 }], since, until, 0)).toEqual([]);
  });
});

describe("dailyCountsFromTimestamps", () => {
  it("groups per-event timestamps into UTC per-day counts, sorted ascending", () => {
    const result = dailyCountsFromTimestamps([
      "2026-01-05T10:00:00Z",
      "2026-01-05T23:00:00Z",
      Date.UTC(2026, 0, 7, 8, 0, 0), // epoch millis accepted too
    ]);
    expect(result).toEqual([
      { date: "2026-01-05", count: 2 },
      { date: "2026-01-07", count: 1 },
    ]);
  });

  it("keys by the UTC calendar day (matching the server's date_trunc)", () => {
    // 23:30Z on Jan 5 stays on Jan 5; 00:30Z on Jan 6 is Jan 6 — a pure UTC split.
    const result = dailyCountsFromTimestamps(["2026-01-05T23:30:00Z", "2026-01-06T00:30:00Z"]);
    expect(result).toEqual([
      { date: "2026-01-05", count: 1 },
      { date: "2026-01-06", count: 1 },
    ]);
  });

  it("skips unparseable entries and returns [] when nothing is valid", () => {
    expect(dailyCountsFromTimestamps(["not-a-date", ""])).toEqual([]);
  });
});
