// Unit tests for collapseActivityFeed (G3 — recent-activity feed grouping).
//
// Timestamps use a mid-day UTC instant so the AR-day bucket (UTC-3) is
// unambiguous: "2026-07-15T13:00:00Z" = 10:00 ART on 2026-07-15.

import { describe, expect, it } from "vitest";

import { type ActivityFeedEntry, collapseActivityFeed } from "./activity-feed";

function e(id: string, action: string, iso: string): ActivityFeedEntry {
  return { id, action, performedAt: new Date(iso) };
}

describe("collapseActivityFeed", () => {
  it("collapses consecutive same-day pii_queried rows into one counted group", () => {
    const rows = collapseActivityFeed([
      e("1", "pii_queried", "2026-07-15T15:00:00Z"),
      e("2", "pii_queried", "2026-07-15T14:00:00Z"),
      e("3", "pii_queried", "2026-07-15T13:00:00Z"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].day).toBe("2026-07-15");
    // Newest entry supplies the id + timestamp (input is DESC).
    expect(rows[0].id).toBe("1");
    expect(rows[0].performedAt.toISOString()).toBe("2026-07-15T15:00:00.000Z");
  });

  it("passes non-collapse actions through untouched (count 1)", () => {
    const rows = collapseActivityFeed([
      e("1", "welfare_assigned", "2026-07-15T15:00:00Z"),
      e("2", "welfare_triaged", "2026-07-15T14:00:00Z"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it("does NOT merge across a real decision between two search runs", () => {
    const rows = collapseActivityFeed([
      e("1", "pii_queried", "2026-07-15T16:00:00Z"),
      e("2", "pii_queried", "2026-07-15T15:00:00Z"),
      e("3", "welfare_assigned", "2026-07-15T14:00:00Z"),
      e("4", "pii_queried", "2026-07-15T13:00:00Z"),
    ]);
    expect(rows.map((r) => [r.action, r.count])).toEqual([
      ["pii_queried", 2],
      ["welfare_assigned", 1],
      ["pii_queried", 1],
    ]);
  });

  it("splits a run that crosses an Argentine day boundary into one group per day", () => {
    const rows = collapseActivityFeed([
      e("1", "pii_queried", "2026-07-15T13:00:00Z"),
      e("2", "pii_queried", "2026-07-14T13:00:00Z"),
      e("3", "pii_queried", "2026-07-14T12:00:00Z"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ day: "2026-07-15", count: 1 });
    expect(rows[1]).toMatchObject({ day: "2026-07-14", count: 2 });
  });

  it("returns an empty array for no entries", () => {
    expect(collapseActivityFeed([])).toEqual([]);
  });
});
