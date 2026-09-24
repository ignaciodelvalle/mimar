// Tests for confidence tier integration in govt surveillance dashboards (plan §A.5).
//
// The tier-based filter "Solo verificados institucionalmente" uses
// isAtLeast(signal.confidenceTier, "professional_verified"). This test verifies
// that the filtering logic is correct using synthetic SurveillanceSignal-like
// objects with confidence data.

import { type ConfidenceTier, computeConfidence, isAtLeast } from "@/lib/events/event-confidence";
import { describe, expect, it } from "vitest";

// Simplified signal type for filtering tests (mirrors the shape we'll add to SurveillanceSignal)
type MinimalSignalWithTier = {
  signalEventId: string;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
};

function signalConfidenceTier(signal: MinimalSignalWithTier): ConfidenceTier {
  return computeConfidence({
    authorRole: signal.authorRole,
    authorVerified: signal.authorVerified,
    authorOrganizationId: signal.authorOrganizationId,
    payload: signal.payload,
  });
}

function filterVerifiedSignals(
  signals: MinimalSignalWithTier[],
  minimum: ConfidenceTier,
): MinimalSignalWithTier[] {
  return signals.filter((s) => isAtLeast(signalConfidenceTier(s), minimum));
}

describe("govt surveillance confidence tier filter (A.5)", () => {
  const signals: MinimalSignalWithTier[] = [
    {
      signalEventId: "evt-1",
      authorRole: "shelter",
      authorVerified: true,
      authorOrganizationId: "org-1",
      payload: {},
    },
    {
      signalEventId: "evt-2",
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: null,
      payload: {},
    },
    {
      signalEventId: "evt-3",
      authorRole: "owner",
      authorVerified: false,
      authorOrganizationId: null,
      payload: {},
    },
    {
      signalEventId: "evt-4",
      authorRole: "scanner",
      authorVerified: false,
      authorOrganizationId: null,
      payload: {},
    },
    {
      signalEventId: "evt-5",
      authorRole: "vet",
      authorVerified: false,
      authorOrganizationId: null,
      payload: { confirmed_by_lab: true },
    },
  ];

  it("no filter → all 5 signals", () => {
    expect(signals).toHaveLength(5);
  });

  it("filter >= professional_verified → 3 signals (shelter, vet verified, lab bumper)", () => {
    const filtered = filterVerifiedSignals(signals, "professional_verified");
    expect(filtered.map((s) => s.signalEventId).sort()).toEqual(["evt-1", "evt-2", "evt-5"]);
  });

  it("filter >= institutional_verified → 2 signals (shelter, lab bumper)", () => {
    const filtered = filterVerifiedSignals(signals, "institutional_verified");
    expect(filtered.map((s) => s.signalEventId).sort()).toEqual(["evt-1", "evt-5"]);
  });

  it("filter >= self_reported → 4 signals (all except scanner/unverified)", () => {
    const filtered = filterVerifiedSignals(signals, "self_reported");
    expect(filtered.map((s) => s.signalEventId).sort()).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
      "evt-5",
    ]);
  });

  it("isAtLeast works consistently for the checkbox label 'Solo verificados institucionalmente'", () => {
    // The checkbox in the UI maps to: isAtLeast(tier, "professional_verified")
    const vetVerified = computeConfidence({
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: null,
      payload: {},
    });
    const ownerSelf = computeConfidence({
      authorRole: "owner",
      authorVerified: false,
      authorOrganizationId: null,
      payload: {},
    });

    expect(isAtLeast(vetVerified, "professional_verified")).toBe(true);
    expect(isAtLeast(ownerSelf, "professional_verified")).toBe(false);
  });
});
