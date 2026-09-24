import { describe, expect, it } from "vitest";

import {
  WELFARE_SEVERITY_RANK,
  WELFARE_SLA_DAYS,
  decodeRiskCursor,
  encodeRiskCursor,
  isSlaBreached,
  severityRank,
  slaDaysForSeverity,
} from "../welfare-sla";

const NOW = new Date("2026-07-18T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("severityRank", () => {
  it("orders critical > high > medium > low", () => {
    expect(WELFARE_SEVERITY_RANK.critical).toBeGreaterThan(WELFARE_SEVERITY_RANK.high);
    expect(WELFARE_SEVERITY_RANK.high).toBeGreaterThan(WELFARE_SEVERITY_RANK.medium);
    expect(WELFARE_SEVERITY_RANK.medium).toBeGreaterThan(WELFARE_SEVERITY_RANK.low);
  });

  it("sinks unknown/legacy severities below every real tier", () => {
    expect(severityRank("unknown-legacy")).toBe(-1);
    expect(severityRank("low")).toBe(0);
  });
});

describe("slaDaysForSeverity", () => {
  it("tiers anchor on the pre-existing 7-day 'Atrasadas' convention at medium", () => {
    expect(WELFARE_SLA_DAYS.medium).toBe(7);
    expect(WELFARE_SLA_DAYS.critical).toBeLessThan(WELFARE_SLA_DAYS.high);
    expect(WELFARE_SLA_DAYS.high).toBeLessThan(WELFARE_SLA_DAYS.medium);
    expect(WELFARE_SLA_DAYS.medium).toBeLessThan(WELFARE_SLA_DAYS.low);
  });

  it("unknown severity gets the loosest tier (never a fabricated urgency)", () => {
    expect(slaDaysForSeverity("whatever")).toBe(WELFARE_SLA_DAYS.low);
  });
});

describe("isSlaBreached", () => {
  it("critical breaches after 1 day, not before", () => {
    expect(isSlaBreached("critical", "open", daysAgo(2), NOW)).toBe(true);
    expect(isSlaBreached("critical", "open", daysAgo(0.5), NOW)).toBe(false);
  });

  it("medium follows the 7-day convention", () => {
    expect(isSlaBreached("medium", "in_progress", daysAgo(8), NOW)).toBe(true);
    expect(isSlaBreached("medium", "in_progress", daysAgo(6), NOW)).toBe(false);
  });

  it("terminal statuses never breach", () => {
    expect(isSlaBreached("critical", "closed", daysAgo(30), NOW)).toBe(false);
    expect(isSlaBreached("high", "duplicate", daysAgo(30), NOW)).toBe(false);
    expect(isSlaBreached("high", "invalid", daysAgo(30), NOW)).toBe(false);
  });
});

describe("risk cursor", () => {
  const ID = "0d9f5f9c-2b7a-4b0e-9a63-1c2d3e4f5a6b";

  it("round-trips (rank, ts, id)", () => {
    const cursor = encodeRiskCursor(3, NOW, ID);
    expect(decodeRiskCursor(cursor)).toEqual({ rank: 3, ts: NOW.toISOString(), id: ID });
  });

  it("rejects malformed and legacy 2-part cursors (falls back to page 1)", () => {
    expect(decodeRiskCursor(null)).toBeNull();
    expect(decodeRiskCursor("")).toBeNull();
    expect(decodeRiskCursor("not-base64url!!")).toBeNull();
    // Legacy (ts|id) cursor from the old createdAt-DESC keyset.
    const legacy = Buffer.from(`${NOW.toISOString()}|${ID}`, "utf8").toString("base64url");
    expect(decodeRiskCursor(legacy)).toBeNull();
  });

  it("rejects attacker-shaped rank / timestamp / uuid parts", () => {
    const bad = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    expect(decodeRiskCursor(bad(`x|${NOW.toISOString()}|${ID}`))).toBeNull();
    expect(decodeRiskCursor(bad(`3|Jan 1 2026|${ID}`))).toBeNull();
    expect(decodeRiskCursor(bad(`3|${NOW.toISOString()}|not-a-uuid`))).toBeNull();
  });
});
