// lib/metrics/context.test.ts — unit tests for the pure ProjectionContext
// predicates. No DB: these exercise scope/grain logic only.

import { describe, expect, it } from "vitest";

import {
  buildProjectionContext,
  censusEligibleProvince,
  isSubProvincialScope,
} from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

const PERIOD = windows.trailing12m();

describe("isSubProvincialScope", () => {
  it("national admin (no drill-down) is NOT sub-provincial", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD);
    expect(isSubProvincialScope(ctx)).toBe(false);
  });

  it("admin drilled to a province (no locality) is NOT sub-provincial", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD, {
      adminProvince: "Buenos Aires",
    });
    expect(isSubProvincialScope(ctx)).toBe(false);
  });

  it("admin drilled to a locality IS sub-provincial", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD, {
      adminProvince: "Ciudad Autónoma de Buenos Aires",
      adminLocality: "Palermo",
    });
    expect(isSubProvincialScope(ctx)).toBe(true);
  });

  it("govt scoped to a WHOLE province (locality === '') is NOT sub-provincial", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "" }],
      PERIOD,
    );
    expect(isSubProvincialScope(ctx)).toBe(false);
  });

  it("govt scoped to a specific locality IS sub-provincial", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "CABA", locality: "Palermo" }],
      PERIOD,
    );
    expect(isSubProvincialScope(ctx)).toBe(true);
  });

  it("govt scoped to WHOLE CABA (two-tier canonical form) is NOT sub-provincial", () => {
    // The canonical whole-province form for CABA is the INDEC whole-city entry,
    // NOT locality === "". It has a census row and an honest per-10k rate, so it
    // must NOT be suppressed (regression guard for the fresh-review H-1 finding).
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
      PERIOD,
    );
    expect(isSubProvincialScope(ctx)).toBe(false);
  });

  it("govt with a MIXED scope (a whole province + a specific locality) IS sub-provincial", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [
        { province: "Córdoba", locality: "" },
        { province: "Buenos Aires", locality: "La Plata" },
      ],
      PERIOD,
    );
    expect(isSubProvincialScope(ctx)).toBe(true);
  });

  it("govt with an empty scope is NOT sub-provincial", () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], PERIOD);
    expect(isSubProvincialScope(ctx)).toBe(false);
  });
});

describe("censusEligibleProvince (C3, red-team #2 PO-locked direction)", () => {
  it("national admin (no drill-down) → null", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD);
    expect(censusEligibleProvince(ctx)).toBeNull();
  });

  it("admin drilled to a province (no locality) → that province", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD, {
      adminProvince: "Buenos Aires",
    });
    expect(censusEligibleProvince(ctx)).toBe("Buenos Aires");
  });

  it("admin drilled to a locality → null (finer than province grain)", () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], PERIOD, {
      adminProvince: "Ciudad Autónoma de Buenos Aires",
      adminLocality: "Palermo",
    });
    expect(censusEligibleProvince(ctx)).toBeNull();
  });

  it("govt scoped to a WHOLE province (locality === '') → that province", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "" }],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBe("Buenos Aires");
  });

  it("govt scoped to WHOLE CABA (two-tier canonical form) → 'CABA'", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBe("CABA");
  });

  // THE PARTIAL-PROVINCE CORRECTION (demo review 2026-08-01). This test used
  // to assert the opposite — "barrio-multi govt whose view aggregates one
  // whole province → that province" — on the reasoning that several barrios
  // "aggregate into a province-wide VIEW". They do not: 5 of CABA's 48
  // barrios is 5 barrios. Measured live with exactly this mandate: 662
  // registered dogs over the whole-CABA canine estimate (≈3,12M × 0.158 ≈
  // 493.000) rendered as "0,1% del padrón sobre la población canina
  // estimada", roughly an order of magnitude under the truth, and the same
  // gate understated "Mordeduras / 10k hab." by the same ratio.
  it("a govt holding SOME barrios of a province is NOT census-eligible — 5 of 48 is not CABA", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [
        { province: "CABA", locality: "Palermo" },
        { province: "CABA", locality: "Recoleta" },
        { province: "CABA", locality: "Retiro" },
        { province: "CABA", locality: "San Nicolás" },
        { province: "CABA", locality: "Puerto Madero" },
      ],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBeNull();
  });

  it("a whole-province assignment stays eligible even when barrios sit beside it", () => {
    // The mandate covers all of CABA (the whole-city row) plus a redundant
    // barrio entry — the view genuinely spans the province the census
    // describes, so the denominator is honest.
    const ctx = buildProjectionContext(
      { role: "govt" },
      [
        { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" },
        { province: "CABA", locality: "Palermo" },
      ],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBe("CABA");
  });

  it("locality-drill — a single specific locality → null", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "CABA", locality: "Palermo" }],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBeNull();
  });

  it("govt scope spanning multiple provinces → null (no single census row applies)", () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [
        { province: "Córdoba", locality: "" },
        { province: "Buenos Aires", locality: "La Plata" },
      ],
      PERIOD,
    );
    expect(censusEligibleProvince(ctx)).toBeNull();
  });

  it("govt with an empty scope → null", () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], PERIOD);
    expect(censusEligibleProvince(ctx)).toBeNull();
  });
});
