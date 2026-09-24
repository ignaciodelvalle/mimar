// Unit tests for the /admin/auditoria filter helpers (#55 dashboard drill fix).
// Pure — no DB. Pins the multi-action + date-range parsing and the "Decisiones
// 7d" KPI drill href so the tile can never regress back to linking the
// all-time, all-action audit log.

import { describe, expect, it } from "vitest";

import { AUDIT_ACTION_LABELS } from "@/lib/ui/audit-action-labels";
import {
  DECISION_AUDIT_ACTIONS,
  buildAuditActionOptions,
  decisionsAuditDrillHref,
  parseAuditActions,
  parseAuditDateRange,
} from "@/lib/ui/audit-filters";

describe("parseAuditActions", () => {
  it("returns an empty list for null/undefined/empty", () => {
    expect(parseAuditActions(null)).toEqual([]);
    expect(parseAuditActions(undefined)).toEqual([]);
    expect(parseAuditActions("")).toEqual([]);
  });

  it("parses a single valid action code", () => {
    expect(parseAuditActions("request_approved")).toEqual(["request_approved"]);
  });

  it("parses a comma-separated list of valid codes (the decisions drill)", () => {
    expect(parseAuditActions("request_approved,request_rejected")).toEqual([
      "request_approved",
      "request_rejected",
    ]);
  });

  it("trims whitespace and drops unknown/duplicate codes", () => {
    expect(parseAuditActions(" request_approved , not_a_real_action , request_approved ")).toEqual([
      "request_approved",
    ]);
  });

  // `?action=a&action=b` makes Next pass a string[]. `raw.split(",")` threw
  // "raw.split is not a function" and 500'd /admin/auditoria,
  // /admin/historial and /gob/historial — three pages, one helper.
  it("accepts a REPEATED param (string[]) instead of throwing", () => {
    expect(() => parseAuditActions(["request_approved"])).not.toThrow();
    // Concatenated, not first-wins: this param is already a list, so
    // ?action=a&action=b unambiguously means both.
    expect(parseAuditActions(["request_approved", "request_rejected"])).toEqual([
      "request_approved",
      "request_rejected",
    ]);
  });

  it("applies the same validation to every value of a repeated param", () => {
    // The load-bearing half: joining must not become a bypass. An unknown code
    // arriving in the SECOND array entry has to be dropped exactly like one
    // arriving after a comma.
    expect(parseAuditActions(["request_approved", "not_a_real_action"])).toEqual([
      "request_approved",
    ]);
    expect(parseAuditActions(["request_approved,request_rejected", "request_approved"])).toEqual([
      "request_approved",
      "request_rejected",
    ]);
  });

  it("returns an empty list for an empty repeated param", () => {
    expect(parseAuditActions([])).toEqual([]);
  });
});

describe("parseAuditDateRange", () => {
  it("returns null bounds when both params are absent", () => {
    expect(parseAuditDateRange(undefined, undefined)).toEqual({ since: null, until: null });
  });

  // AR calendar days (PO 2026-07-16): midnight AR = 03:00Z (fixed -03:00, no DST).
  it("parses `from` to an AR-midnight inclusive lower bound (03:00Z)", () => {
    const { since, until } = parseAuditDateRange("2026-06-27", undefined);
    expect(since?.toISOString()).toBe("2026-06-27T03:00:00.000Z");
    expect(until).toBeNull();
  });

  it("makes `to` inclusive by advancing `until` to the next AR midnight", () => {
    const { until } = parseAuditDateRange(undefined, "2026-06-27");
    expect(until?.toISOString()).toBe("2026-06-28T03:00:00.000Z");
  });

  it("rejects malformed and rolled-over dates", () => {
    expect(parseAuditDateRange("2026/06/27", "13-40-2026")).toEqual({ since: null, until: null });
    // 2026-02-30 would silently normalise to Mar 2 — must be rejected.
    expect(parseAuditDateRange("2026-02-30", null).since).toBeNull();
  });
});

describe("decisionsAuditDrillHref", () => {
  it("carries both decision actions and a trailing-7d `from` date", () => {
    const now = new Date("2026-07-04T12:00:00Z").getTime();
    const href = decisionsAuditDrillHref(now);
    expect(href).toContain("action=request_approved,request_rejected");
    expect(href).toContain("from=2026-06-27");
  });

  it("computes `from` on the ARGENTINE calendar day (not the UTC day)", () => {
    // 2026-07-04T01:00Z is still 2026-07-03 22:00 in AR, so 7 days back lands
    // on the AR day 2026-06-26 even though the UTC day is 2026-06-27.
    const now = new Date("2026-07-04T01:00:00Z").getTime();
    expect(decisionsAuditDrillHref(now)).toContain("from=2026-06-26");
  });

  it("the drill's action param round-trips through parseAuditActions", () => {
    const href = decisionsAuditDrillHref(Date.now());
    const actionParam = new URL(href, "https://x").searchParams.get("action");
    expect(parseAuditActions(actionParam)).toEqual([...DECISION_AUDIT_ACTIONS]);
  });
});

describe("buildAuditActionOptions", () => {
  it("renders one option per UNIQUE label — no duplicate dropdown rows", () => {
    const options = buildAuditActionOptions();
    const labels = options.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every option's value carries every code that shares its label", () => {
    const options = buildAuditActionOptions();
    for (const [code, label] of Object.entries(AUDIT_ACTION_LABELS)) {
      const option = options.find((o) => o.label === label);
      expect(option).toBeDefined();
      expect(option?.value.split(",")).toContain(code);
    }
  });

  it("options are sorted by label (es-AR)", () => {
    const options = buildAuditActionOptions();
    const labels = options.map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, "es-AR"));
    expect(labels).toEqual(sorted);
  });
});
