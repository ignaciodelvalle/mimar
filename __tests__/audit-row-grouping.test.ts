// Unit tests for lib/ui/audit-row-grouping.ts — collapsing consecutive runs of
// identical (action + actor) audit rows so a bulk backfill can't bury signal.
// Pure helper — no DB, no React.

import { describe, expect, it } from "vitest";

import {
  COLLAPSE_MIN_RUN,
  type GroupableAuditRow,
  groupConsecutiveAuditRows,
} from "@/lib/ui/audit-row-grouping";

const row = (
  id: string,
  action: string,
  actorUserId: string | null,
  performedAt = new Date("2026-07-03T22:00:00Z"),
): GroupableAuditRow => ({ id, action, actorUserId, performedAt });

describe("groupConsecutiveAuditRows", () => {
  it("returns an empty array for no rows", () => {
    expect(groupConsecutiveAuditRows([])).toEqual([]);
  });

  it("keeps distinct rows as singles", () => {
    const rows = [
      row("1", "pii_queried", "a"),
      row("2", "request_approved", "a"),
      row("3", "revocation_vet", "b"),
    ];
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.kind === "single")).toBe(true);
  });

  it("does NOT collapse a run shorter than COLLAPSE_MIN_RUN", () => {
    // Two identical rows stay individual — a short burst is signal, not noise.
    const rows = [row("1", "override", "a"), row("2", "override", "a")];
    const groups = groupConsecutiveAuditRows(rows);
    expect(COLLAPSE_MIN_RUN).toBeGreaterThan(2);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "single")).toBe(true);
  });

  it("collapses a run of COLLAPSE_MIN_RUN identical action+actor rows", () => {
    const rows = Array.from({ length: COLLAPSE_MIN_RUN }, (_, i) => row(`${i}`, "override", "a"));
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g.kind).toBe("run");
    if (g.kind === "run") {
      expect(g.count).toBe(COLLAPSE_MIN_RUN);
      expect(g.action).toBe("override");
      expect(g.actorUserId).toBe("a");
      expect(g.rows).toHaveLength(COLLAPSE_MIN_RUN);
    }
  });

  it("collapses a large flood into one group with the right count", () => {
    const rows = Array.from({ length: 147 }, (_, i) =>
      row(`${i}`, "pet_events_mutation_override", "admin-1"),
    );
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("run");
    if (groups[0].kind === "run") expect(groups[0].count).toBe(147);
  });

  it("splits runs by actor even when the action matches", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(`a${i}`, "override", "a")),
      ...Array.from({ length: 3 }, (_, i) => row(`b${i}`, "override", "b")),
    ];
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "run")).toBe(true);
  });

  it("treats null actor as its own key (does not merge with a named actor)", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(`n${i}`, "override", null)),
      ...Array.from({ length: 3 }, (_, i) => row(`a${i}`, "override", "a")),
    ];
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(2);
    if (groups[0].kind === "run") expect(groups[0].actorUserId).toBeNull();
  });

  it("keeps singles around a collapsed flood (no row is ever hidden)", () => {
    const rows = [
      row("head", "pii_queried", "a"),
      ...Array.from({ length: 10 }, (_, i) => row(`f${i}`, "override", "sys")),
      row("tail", "revocation_vet", "b"),
    ];
    const groups = groupConsecutiveAuditRows(rows);
    expect(groups).toHaveLength(3);
    expect(groups[0].kind).toBe("single");
    expect(groups[1].kind).toBe("run");
    expect(groups[2].kind).toBe("single");
    // Every input row is accounted for.
    const total = groups.reduce((n, g) => n + (g.kind === "run" ? g.count : 1), 0);
    expect(total).toBe(rows.length);
  });

  it("exposes earliest/latest from a DESC-ordered run", () => {
    const newest = new Date("2026-07-03T22:01:00Z");
    const oldest = new Date("2026-07-03T21:59:00Z");
    const rows = [
      row("1", "override", "a", newest),
      row("2", "override", "a", new Date("2026-07-03T22:00:00Z")),
      row("3", "override", "a", oldest),
    ];
    const [g] = groupConsecutiveAuditRows(rows);
    if (g.kind === "run") {
      expect(g.latestAt).toEqual(newest);
      expect(g.earliestAt).toEqual(oldest);
    }
  });

  it("respects a custom minRun", () => {
    const rows = [row("1", "override", "a"), row("2", "override", "a")];
    const groups = groupConsecutiveAuditRows(rows, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("run");
  });
});
