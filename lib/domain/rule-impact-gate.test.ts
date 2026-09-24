import { describe, expect, it } from "vitest";

import { canSaveWithImpactGate, requiresImpactConfirmation } from "@/lib/domain/rule-impact-gate";

describe("requiresImpactConfirmation (C9 — PPP impact gate)", () => {
  it("requires confirmation while the preview is loading (operator must not outrun the estimate)", () => {
    expect(
      requiresImpactConfirmation({ status: "loading", count: null, acknowledged: false }),
    ).toBe(true);
  });

  it("requires confirmation when the preview reports affected pets (count > 0)", () => {
    expect(requiresImpactConfirmation({ status: "done", count: 42, acknowledged: false })).toBe(
      true,
    );
  });

  it("does NOT require confirmation when no pets are affected (count === 0)", () => {
    expect(requiresImpactConfirmation({ status: "done", count: 0, acknowledged: false })).toBe(
      false,
    );
  });

  it("does NOT require confirmation when the preview errored (non-blocking, advisory)", () => {
    expect(requiresImpactConfirmation({ status: "error", count: null, acknowledged: false })).toBe(
      false,
    );
  });

  it("does NOT require confirmation when idle (no candidate rule yet)", () => {
    expect(requiresImpactConfirmation({ status: "idle", count: null, acknowledged: false })).toBe(
      false,
    );
  });
});

describe("canSaveWithImpactGate (C9 — PPP impact gate)", () => {
  it("blocks save when impact is known (>0) but NOT acknowledged", () => {
    expect(canSaveWithImpactGate({ status: "done", count: 42, acknowledged: false })).toBe(false);
  });

  it("allows save once the operator acknowledges a known, non-zero impact", () => {
    expect(canSaveWithImpactGate({ status: "done", count: 42, acknowledged: true })).toBe(true);
  });

  it("blocks save while still loading even if acknowledged (count unknown)", () => {
    expect(canSaveWithImpactGate({ status: "loading", count: null, acknowledged: true })).toBe(
      false,
    );
  });

  it("allows save with zero impact without any acknowledgement", () => {
    expect(canSaveWithImpactGate({ status: "done", count: 0, acknowledged: false })).toBe(true);
  });

  it("allows save when the preview errored (advisory, non-blocking)", () => {
    expect(canSaveWithImpactGate({ status: "error", count: null, acknowledged: false })).toBe(true);
  });

  it("allows save when idle (no candidate breeds selected)", () => {
    expect(canSaveWithImpactGate({ status: "idle", count: null, acknowledged: false })).toBe(true);
  });
});
