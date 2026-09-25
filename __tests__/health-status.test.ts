// Unit tests for evaluateHealth() — lib/infra/health-status.ts
//
// Pure decision-table tests: no DB, no server. They pin the /api/health contract
// the external poller relies on (200 only when fully healthy; 503 otherwise).

import { describe, expect, it } from "vitest";

import { DEGRADED_PING_MS, evaluateHealth } from "@/lib/infra/health-status";

describe("evaluateHealth", () => {
  it("healthy DB, fast ping, no stuck backends → ok / 200", () => {
    expect(evaluateHealth({ dbOk: true, pingMs: 40, stuckBackends: 0 })).toEqual({
      status: "ok",
      degraded: false,
      httpStatus: 200,
    });
  });

  it("DB ping failed → down / 503 regardless of other signals", () => {
    expect(evaluateHealth({ dbOk: false, pingMs: 5, stuckBackends: 0 })).toEqual({
      status: "down",
      degraded: true,
      httpStatus: 503,
    });
  });

  it("ok ping but slow (> DEGRADED_PING_MS) → degraded / 503", () => {
    expect(evaluateHealth({ dbOk: true, pingMs: DEGRADED_PING_MS + 1, stuckBackends: 0 })).toEqual({
      status: "degraded",
      degraded: true,
      httpStatus: 503,
    });
  });

  it("ping exactly at the threshold is NOT degraded (strictly greater)", () => {
    expect(evaluateHealth({ dbOk: true, pingMs: DEGRADED_PING_MS, stuckBackends: 0 })).toEqual({
      status: "ok",
      degraded: false,
      httpStatus: 200,
    });
  });

  it("stuck backends present (> 0) → degraded / 503 even on a fast ping", () => {
    expect(evaluateHealth({ dbOk: true, pingMs: 30, stuckBackends: 3 })).toEqual({
      status: "degraded",
      degraded: true,
      httpStatus: 503,
    });
  });

  it("unknown stuck count (null) never forces degraded on its own → ok / 200", () => {
    expect(evaluateHealth({ dbOk: true, pingMs: 30, stuckBackends: null })).toEqual({
      status: "ok",
      degraded: false,
      httpStatus: 200,
    });
  });

  // R9 of the 2026-09-25 localities audit: code that writes a column its
  // database does not have yet fails every write that touches it (0246 and
  // govt account creation). The probe must say so before a person finds out.
  it("a required column missing from the schema → degraded / 503 on a fast ping", () => {
    expect(
      evaluateHealth({ dbOk: true, pingMs: 30, stuckBackends: 0, missingRequiredColumns: 1 }),
    ).toEqual({ status: "degraded", degraded: true, httpStatus: 503 });
  });

  it("every required column present (0) → ok / 200", () => {
    expect(
      evaluateHealth({ dbOk: true, pingMs: 30, stuckBackends: 0, missingRequiredColumns: 0 }),
    ).toEqual({ status: "ok", degraded: false, httpStatus: 200 });
  });

  it("unknown schema check (null) never forces degraded on its own → ok / 200", () => {
    expect(
      evaluateHealth({ dbOk: true, pingMs: 30, stuckBackends: 0, missingRequiredColumns: null }),
    ).toEqual({ status: "ok", degraded: false, httpStatus: 200 });
  });
});
