// Unit tests for proposal-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.4) before creating proposal-rules.ts.

import { describe, expect, it } from "vitest";

import {
  computeProposalExpiresAt,
  isCoFosterBlocked,
  isDuplicatePendingBlocked,
  validateRejectionReason,
} from "../proposal-rules";

describe("validateRejectionReason", () => {
  it("returns ok for 'capacity'", () => {
    expect(validateRejectionReason("capacity")).toMatchObject({ ok: true });
  });

  it("returns ok for 'health_mismatch'", () => {
    expect(validateRejectionReason("health_mismatch")).toMatchObject({ ok: true });
  });

  it("returns ok for 'timing'", () => {
    expect(validateRejectionReason("timing")).toMatchObject({ ok: true });
  });

  it("returns ok for 'distance'", () => {
    expect(validateRejectionReason("distance")).toMatchObject({ ok: true });
  });

  it("returns ok for 'household'", () => {
    expect(validateRejectionReason("household")).toMatchObject({ ok: true });
  });

  it("returns ok for 'other'", () => {
    expect(validateRejectionReason("other")).toMatchObject({ ok: true });
  });

  it("returns error for an unknown reason", () => {
    expect(validateRejectionReason("bad_reason")).toMatchObject({
      ok: false,
      error: expect.stringContaining("inválido"),
    });
  });

  it("returns error for empty string", () => {
    expect(validateRejectionReason("")).toMatchObject({ ok: false });
  });
});

describe("computeProposalExpiresAt", () => {
  it("returns a date exactly 7 days after the given now", () => {
    const now = new Date("2024-01-01T00:00:00.000Z");
    const expires = computeProposalExpiresAt(now);
    const diffMs = expires.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  it("works for different base dates (triangulation)", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    const expires = computeProposalExpiresAt(now);
    expect(expires.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("isCoFosterBlocked", () => {
  it("returns false when no active foster rows exist", () => {
    expect(isCoFosterBlocked([])).toBe(false);
  });

  it("returns false when all active rows allow co-foster", () => {
    expect(isCoFosterBlocked([{ allowCoFoster: true }, { allowCoFoster: true }])).toBe(false);
  });

  it("returns true when at least one row does NOT allow co-foster", () => {
    expect(isCoFosterBlocked([{ allowCoFoster: false }])).toBe(true);
  });

  it("returns true when mixed (one allows, one does not)", () => {
    expect(isCoFosterBlocked([{ allowCoFoster: true }, { allowCoFoster: false }])).toBe(true);
  });
});

describe("isDuplicatePendingBlocked", () => {
  it("returns false when no duplicate exists", () => {
    expect(isDuplicatePendingBlocked(false)).toBe(false);
  });

  it("returns true when a duplicate pending proposal exists", () => {
    expect(isDuplicatePendingBlocked(true)).toBe(true);
  });
});
