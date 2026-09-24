// Unit tests for lib/disposition — the disposition-method bucket map and
// traceability predicate. Pure functions, no DB.
//
// The truth table covers EVERY value the deathRecorded.disposition_method enum
// (lib/event-schemas.ts) and DeathRecordForm option list can emit, plus null.
// If the form gains an option the bucket map doesn't know, bucketOf must still
// return a defined bucket ('other') — never undefined — and this test guards it.

import { describe, expect, it } from "vitest";

import {
  type DispositionBucket,
  type DispositionMethod,
  bucketOf,
  isTraceable,
} from "@/lib/domain/disposition";

describe("bucketOf", () => {
  const cases: Array<[DispositionMethod | null, DispositionBucket]> = [
    ["cremation_collective", "cremation"],
    ["cremation_individual_ashes", "cremation"],
    ["authorized_cemetery", "authorized_burial"],
    ["owner_burial", "home_burial"],
    ["household_waste", "other"],
    ["rendering", "rendering"],
    ["unknown", "other"],
    [null, "other"],
  ];

  it.each(cases)("maps %s → %s", (method, bucket) => {
    expect(bucketOf(method)).toBe(bucket);
  });

  it("falls back to 'other' for an unrecognized future value", () => {
    // Simulate the form adding a new option the map doesn't cover yet.
    expect(bucketOf("some_future_method" as unknown as DispositionMethod)).toBe("other");
  });
});

describe("isTraceable", () => {
  it("is true when method is known AND facility is present", () => {
    expect(isTraceable("cremation_collective", "Crematorio San Roque")).toBe(true);
    expect(isTraceable("authorized_cemetery", "Cementerio Municipal")).toBe(true);
  });

  it("is false when method is null/unknown regardless of facility", () => {
    expect(isTraceable(null, "Some facility")).toBe(false);
    expect(isTraceable("unknown", "Some facility")).toBe(false);
  });

  it("is false when facility is missing/blank even for a known method", () => {
    expect(isTraceable("cremation_collective", null)).toBe(false);
    expect(isTraceable("cremation_collective", "")).toBe(false);
    expect(isTraceable("cremation_collective", "   ")).toBe(false);
  });

  it("treats household_waste/rendering as known methods (traceable with a facility)", () => {
    expect(isTraceable("rendering", "Planta de procesamiento")).toBe(true);
    // household_waste without a facility is not traceable.
    expect(isTraceable("household_waste", null)).toBe(false);
  });
});
