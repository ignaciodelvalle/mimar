// Unit tests for lib/analytics/jurisdiction-targets.ts (jurisdiction-
// compliance WU4b — spec JT1-JT5, design ADR-8).
//
// The resolver is mocked: these pin the MERGE + CLAMP + FALLBACK contract
// (JT2) and the scope→jurisdiction policy, not the DB cascade (that is
// resolveBusinessRule's own suite). The JT5 fence at the bottom is an fs-scan:
// admin/* surfaces are national by definition and must never import this
// module.

import { globSync, readFileSync } from "node:fs";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { TARGETS } from "@/lib/metrics/targets";

import {
  JURISDICTION_TARGETS_TIMEOUT_MS,
  flatJurisdictionTargets,
  resolveJurisdictionTargets,
  resolveJurisdictionTargetsForScope,
} from "./jurisdiction-targets";

vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: vi.fn(),
}));

const resolverMock = resolveBusinessRule as unknown as Mock;

const resolvedWith = (payload: Record<string, unknown>) => ({
  payload,
  source: "province" as const,
  matchedRow: { id: "r1", country: "AR", province: "Chubut", locality: null },
});

beforeEach(() => {
  resolverMock.mockReset();
  resolverMock.mockResolvedValue(resolvedWith({}));
});

describe("resolveJurisdictionTargets — merge over flat defaults (JT2)", () => {
  it("no override keys → flat TARGETS, nothing adjusted", async () => {
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result).toEqual(flatJurisdictionTargets());
    expect(result.values.RABIES_COVERAGE_PCT).toBe(TARGETS.RABIES_COVERAGE_PCT);
    expect(result.anyAdjusted).toBe(false);
  });

  it("a partial payload adjusts ONLY its keys", async () => {
    resolverMock.mockResolvedValue(resolvedWith({ rabies_coverage_pct: 90 }));
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result.values.RABIES_COVERAGE_PCT).toBe(90);
    expect(result.adjusted.RABIES_COVERAGE_PCT).toBe(true);
    expect(result.values.MICROCHIP_PENETRATION_PCT).toBe(TARGETS.MICROCHIP_PENETRATION_PCT);
    expect(result.adjusted.MICROCHIP_PENETRATION_PCT).toBe(false);
    expect(result.anyAdjusted).toBe(true);
  });

  it("clamps override values to 0..100 (JT2)", async () => {
    resolverMock.mockResolvedValue(
      resolvedWith({ rabies_coverage_pct: 150, sterilization_coverage_pct: -5 }),
    );
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result.values.RABIES_COVERAGE_PCT).toBe(100);
    expect(result.values.STERILIZATION_COVERAGE_PCT).toBe(0);
    expect(result.adjusted.RABIES_COVERAGE_PCT).toBe(true);
    expect(result.adjusted.STERILIZATION_COVERAGE_PCT).toBe(true);
  });

  it("an override EQUAL to the flat default is not 'adjusted' — nothing to disclose", async () => {
    resolverMock.mockResolvedValue(
      resolvedWith({ rabies_coverage_pct: TARGETS.RABIES_COVERAGE_PCT }),
    );
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result.values.RABIES_COVERAGE_PCT).toBe(TARGETS.RABIES_COVERAGE_PCT);
    expect(result.adjusted.RABIES_COVERAGE_PCT).toBe(false);
    expect(result.anyAdjusted).toBe(false);
  });

  it("non-numeric payload garbage is ignored, never NaN-merged", async () => {
    resolverMock.mockResolvedValue(
      resolvedWith({ rabies_coverage_pct: "noventa", microchip_penetration_pct: Number.NaN }),
    );
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result).toEqual(flatJurisdictionTargets());
  });

  it("resolver THROWS → flat TARGETS fallback, never a page failure (JT2 scenario)", async () => {
    resolverMock.mockRejectedValue(new Error("pooler down"));
    const result = await resolveJurisdictionTargets({ province: "Chubut" });
    expect(result).toEqual(flatJurisdictionTargets());
  });

  // T6 review M1: the try/catch only ever covered REJECTIONS. A pooler that
  // accepts the connection and never answers made every /gob screen await this
  // forever, OUTSIDE its own loadWithTimeout group. The deadline now lives in
  // the module, so a stall degrades the meta instead of hanging the dashboard.
  it("resolver HANGS → flat TARGETS at the deadline, never an unbounded await", async () => {
    vi.useFakeTimers();
    try {
      resolverMock.mockImplementation(() => new Promise(() => {}));
      const pending = resolveJurisdictionTargets({ province: "Chubut" });
      await vi.advanceTimersByTimeAsync(JURISDICTION_TARGETS_TIMEOUT_MS + 1);
      await expect(pending).resolves.toEqual(flatJurisdictionTargets());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveJurisdictionTargetsForScope — one normative regime or flat", () => {
  it("empty set (admin universal / national) → flat, resolver never called", async () => {
    const result = await resolveJurisdictionTargetsForScope([]);
    expect(result).toEqual(flatJurisdictionTargets());
    expect(resolverMock).not.toHaveBeenCalled();
  });

  it("multiple provinces → flat, resolver never called (no single regime to disclose)", async () => {
    const result = await resolveJurisdictionTargetsForScope([
      { province: "Chubut", locality: "" },
      { province: "Salta", locality: "" },
    ]);
    expect(result).toEqual(flatJurisdictionTargets());
    expect(resolverMock).not.toHaveBeenCalled();
  });

  it("one province, several localities → resolves at PROVINCE grain", async () => {
    await resolveJurisdictionTargetsForScope([
      { province: "Chubut", locality: "Trelew" },
      { province: "Chubut", locality: "Rawson" },
    ]);
    expect(resolverMock).toHaveBeenCalledWith("compliance_targets", {
      province: "Chubut",
      locality: null,
    });
  });

  it("exactly one (province, locality) pair → resolves at LOCALITY grain (full cascade)", async () => {
    await resolveJurisdictionTargetsForScope([{ province: "Chubut", locality: "Trelew" }]);
    expect(resolverMock).toHaveBeenCalledWith("compliance_targets", {
      province: "Chubut",
      locality: "Trelew",
    });
  });

  it("a whole-province assignment ('' sentinel) resolves at province grain", async () => {
    await resolveJurisdictionTargetsForScope([{ province: "Chubut", locality: "" }]);
    expect(resolverMock).toHaveBeenCalledWith("compliance_targets", {
      province: "Chubut",
      locality: null,
    });
  });
});

describe("JT5 fence — admin/* stays national", () => {
  it("no app/admin source file imports jurisdiction-targets", () => {
    const adminFiles = globSync("app/admin/**/*.{ts,tsx}");
    expect(adminFiles.length).toBeGreaterThan(0); // fail closed on a bad cwd
    const offenders = adminFiles.filter((f) =>
      readFileSync(f, "utf8").includes("jurisdiction-targets"),
    );
    expect(offenders).toEqual([]);
  });
});
