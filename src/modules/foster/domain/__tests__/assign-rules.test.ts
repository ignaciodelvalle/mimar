// Unit tests for assign-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.3) before creating assign-rules.ts.

import { describe, expect, it } from "vitest";

import {
  endReasonToClosedReason,
  parseExpectedWeeks,
  resolveEndFosterReason,
  validateAssignFosterInput,
} from "../assign-rules";

describe("parseExpectedWeeks", () => {
  it("returns null when raw string is empty", () => {
    expect(parseExpectedWeeks("")).toBeNull();
  });

  it("returns null when raw string is only whitespace", () => {
    expect(parseExpectedWeeks("   ")).toBeNull();
  });

  it("parses a positive integer", () => {
    expect(parseExpectedWeeks("4")).toBe(4);
  });

  it("clamps negative parseInt results to 0", () => {
    expect(parseExpectedWeeks("-3")).toBe(0);
  });

  it("returns 0 when raw is not a number (NaN → parseInt → 0)", () => {
    expect(parseExpectedWeeks("abc")).toBe(0);
  });

  it("parses '0' as 0", () => {
    expect(parseExpectedWeeks("0")).toBe(0);
  });

  it("parses '12' as 12", () => {
    expect(parseExpectedWeeks("12")).toBe(12);
  });
});

describe("validateAssignFosterInput", () => {
  it("returns error when fosterUserId is empty", () => {
    const result = validateAssignFosterInput({
      fosterUserId: "",
      expectedWeeksRaw: "",
      notes: null,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("voluntario") });
  });

  it("returns ok when fosterUserId is provided", () => {
    const result = validateAssignFosterInput({
      fosterUserId: "user-uuid",
      expectedWeeksRaw: "",
      notes: null,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("includes parsed expectedWeeks in the result", () => {
    const result = validateAssignFosterInput({
      fosterUserId: "user-uuid",
      expectedWeeksRaw: "8",
      notes: null,
    });
    expect(result).toMatchObject({ ok: true, value: { expectedWeeks: 8 } });
  });

  it("returns null expectedWeeks when raw is empty", () => {
    const result = validateAssignFosterInput({
      fosterUserId: "user-uuid",
      expectedWeeksRaw: "",
      notes: null,
    });
    expect(result).toMatchObject({ ok: true, value: { expectedWeeks: null } });
  });
});

describe("resolveEndFosterReason", () => {
  it("returns 'returned' when reason is blank", () => {
    expect(resolveEndFosterReason("")).toBe("returned");
  });

  it("returns 'returned' when reason is not in the whitelist", () => {
    expect(resolveEndFosterReason("pet_died")).toBe("returned");
  });

  it("returns 'returned' when reason is a valid UI reason", () => {
    expect(resolveEndFosterReason("returned")).toBe("returned");
  });

  it("returns 'early_return_by_foster' for that valid reason", () => {
    expect(resolveEndFosterReason("early_return_by_foster")).toBe("early_return_by_foster");
  });

  it("returns 'lost_unrecovered' for that valid reason", () => {
    expect(resolveEndFosterReason("lost_unrecovered")).toBe("lost_unrecovered");
  });

  it("returns 'other' for that valid reason", () => {
    expect(resolveEndFosterReason("other")).toBe("other");
  });
});

describe("endReasonToClosedReason", () => {
  it("maps 'early_return_by_foster' to 'cancelled'", () => {
    expect(endReasonToClosedReason("early_return_by_foster")).toBe("cancelled");
  });

  it("maps 'returned' to 'resolved'", () => {
    expect(endReasonToClosedReason("returned")).toBe("resolved");
  });

  it("maps 'lost_unrecovered' to 'resolved'", () => {
    expect(endReasonToClosedReason("lost_unrecovered")).toBe("resolved");
  });

  it("maps 'other' to 'resolved'", () => {
    expect(endReasonToClosedReason("other")).toBe("resolved");
  });
});
