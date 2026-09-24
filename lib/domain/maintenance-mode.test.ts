// Tests for lib/domain/maintenance-mode.ts — plain vitest, no DOM needed
// (mirrors lib/domain/demo-mode.ts's own test at __tests__/demo-mode.test.ts).

import { describe, expect, it } from "vitest";

import { isMaintenanceMode } from "./maintenance-mode";

describe("isMaintenanceMode()", () => {
  it('returns true when the env value is "1"', () => {
    expect(isMaintenanceMode("1")).toBe(true);
  });

  it('returns true when the env value is "true"', () => {
    expect(isMaintenanceMode("true")).toBe(true);
  });

  it("returns false when the env value is undefined", () => {
    expect(isMaintenanceMode(undefined)).toBe(false);
  });

  it('returns false when the env value is "false"', () => {
    expect(isMaintenanceMode("false")).toBe(false);
  });

  it("returns false for an unrelated garbage value", () => {
    expect(isMaintenanceMode("banana")).toBe(false);
  });
});
