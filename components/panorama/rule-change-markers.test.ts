// Pure-unit tests for the TimeScrubber rule-change marker view-model
// (política → resultado on the timeline). No React, no DOM, no DB.

import { describe, expect, it } from "vitest";

import {
  RULE_CHANGE_ACTION_LABELS,
  type RuleChangeMarkerDatum,
  bucketRuleChangeMarkers,
  ruleChangeRuleLabel,
  ruleChangeScopeLabel,
} from "@/components/panorama/rule-change-markers";
import { buildScrubWindow } from "@/src/modules/panorama/domain/time-scrub";

const WIN = buildScrubWindow(new Date("2026-06-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));

function marker(overrides: Partial<RuleChangeMarkerDatum> = {}): RuleChangeMarkerDatum {
  return {
    auditId: `a-${Math.random().toString(36).slice(2)}`,
    action: "govt_business_rule_updated",
    ruleType: "microchip_required",
    province: "Salta",
    locality: null,
    changedAt: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

describe("bucketRuleChangeMarkers — track placement", () => {
  it("positions a marker at its day-index fraction on the shared axis", () => {
    const [bucket] = bucketRuleChangeMarkers([marker({ changedAt: "2026-06-15T12:00:00Z" })], WIN);
    expect(bucket.changes).toHaveLength(1);
    expect(bucket.fraction).toBeGreaterThan(0.4);
    expect(bucket.fraction).toBeLessThan(0.6);
  });

  it("DROPS markers outside [since, until] instead of clamping them to an edge", () => {
    const buckets = bucketRuleChangeMarkers(
      [
        marker({ changedAt: "2026-05-01T00:00:00Z" }), // before the window
        marker({ changedAt: "2026-08-01T00:00:00Z" }), // after the window
      ],
      WIN,
    );
    expect(buckets).toEqual([]);
  });

  it("skips unparseable timestamps and returns [] for a degenerate window", () => {
    expect(bucketRuleChangeMarkers([marker({ changedAt: "no-date" })], WIN)).toEqual([]);
    const degenerate = buildScrubWindow(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(bucketRuleChangeMarkers([marker()], degenerate)).toEqual([]);
  });
});

describe("bucketRuleChangeMarkers — same-bucket merge (histogram bucket-index math)", () => {
  it("merges two changes landing in the same 1/48 track bucket into ONE bucket", () => {
    // Both instants round to the SAME day index (15 jun) → same track bucket.
    const buckets = bucketRuleChangeMarkers(
      [
        marker({ auditId: "a1", changedAt: "2026-06-15T09:00:00Z" }),
        marker({ auditId: "a2", changedAt: "2026-06-15T11:00:00Z" }),
      ],
      WIN,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].changes.map((c) => c.auditId)).toEqual(["a1", "a2"]);
  });

  it("keeps well-separated changes in their own buckets, sorted by position", () => {
    const buckets = bucketRuleChangeMarkers(
      [
        marker({ auditId: "late", changedAt: "2026-06-25T00:00:00Z" }),
        marker({ auditId: "early", changedAt: "2026-06-03T00:00:00Z" }),
      ],
      WIN,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].changes[0].auditId).toBe("early");
    expect(buckets[1].changes[0].auditId).toBe("late");
    expect(buckets[0].fraction).toBeLessThan(buckets[1].fraction);
  });
});

describe("marker labels — /admin/inteligencia vocabulary, reused verbatim", () => {
  it("scope label: national / province / province · locality", () => {
    expect(ruleChangeScopeLabel({ province: null, locality: null })).toBe("Nacional");
    expect(ruleChangeScopeLabel({ province: "Salta", locality: null })).toBe("Salta");
    expect(ruleChangeScopeLabel({ province: "Buenos Aires", locality: "La Plata" })).toBe(
      "Buenos Aires · La Plata",
    );
  });

  it("action labels match the inteligencia table's creada/modificada/eliminada", () => {
    expect(RULE_CHANGE_ACTION_LABELS.govt_business_rule_created).toBe("creada");
    expect(RULE_CHANGE_ACTION_LABELS.govt_business_rule_updated).toBe("modificada");
    expect(RULE_CHANGE_ACTION_LABELS.govt_business_rule_deleted).toBe("eliminada");
  });

  it("rule-type label comes from RULE_TYPE_REGISTRY, falling back to the raw id", () => {
    expect(ruleChangeRuleLabel("microchip_required")).toBe("Microchip obligatorio");
    expect(ruleChangeRuleLabel("some_future_rule")).toBe("some_future_rule");
  });
});
