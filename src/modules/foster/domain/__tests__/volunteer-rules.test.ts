// Unit tests for volunteer-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.5) before creating volunteer-rules.ts.

import { describe, expect, it } from "vitest";

import {
  computeNewSlots,
  validateD13PreConditions,
  validateUpsertVolunteerInput,
} from "../volunteer-rules";

// ---------------------------------------------------------------------------
// D13 pre-conditions
// ---------------------------------------------------------------------------

const BASE_PROFILE = {
  accountType: "personal",
  role: "owner",
  dniVerified: true,
  displayName: "Test User",
  phone: "1234567890",
};

describe("validateD13PreConditions", () => {
  it("returns ok for a fully valid profile", () => {
    expect(validateD13PreConditions(BASE_PROFILE)).toMatchObject({ ok: true });
  });

  it("returns error when accountType is not 'personal'", () => {
    expect(
      validateD13PreConditions({ ...BASE_PROFILE, accountType: "institutional" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("personal") });
  });

  it("returns error when role is not 'owner'", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, role: "admin" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("personal"),
    });
  });

  it("returns error when dniVerified is false", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, dniVerified: false })).toMatchObject({
      ok: false,
      error: expect.stringContaining("DNI"),
    });
  });

  it("returns error when dniVerified is null", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, dniVerified: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("DNI"),
    });
  });

  it("returns error when displayName is blank", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, displayName: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("nombre"),
    });
  });

  it("returns error when displayName is null", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, displayName: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("nombre"),
    });
  });

  it("returns error when phone is blank", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, phone: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("teléfono"),
    });
  });

  it("returns error when phone is null", () => {
    expect(validateD13PreConditions({ ...BASE_PROFILE, phone: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("teléfono"),
    });
  });
});

// ---------------------------------------------------------------------------
// Upsert input validation (species + maxDuration)
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  mode: "enroll" as const,
  status: "active" as const,
  acceptsDogs: true,
  acceptsCats: false,
  acceptsOtherSpecies: false,
  acceptsSizeSmall: true,
  acceptsSizeMedium: true,
  acceptsSizeLarge: false,
  acceptsPuppies: false,
  acceptsSeniors: true,
  acceptsChronicConditions: false,
  acceptsDangerousBreeds: false,
};

describe("validateUpsertVolunteerInput", () => {
  it("returns ok for a valid input", () => {
    expect(validateUpsertVolunteerInput(BASE_INPUT)).toMatchObject({ ok: true });
  });

  it("returns error when active and no species selected", () => {
    expect(
      validateUpsertVolunteerInput({
        ...BASE_INPUT,
        acceptsDogs: false,
        acceptsCats: false,
        acceptsOtherSpecies: false,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("especie") });
  });

  it("does NOT return species error when status is 'paused' with no species", () => {
    expect(
      validateUpsertVolunteerInput({
        ...BASE_INPUT,
        status: "paused",
        acceptsDogs: false,
        acceptsCats: false,
        acceptsOtherSpecies: false,
      }),
    ).toMatchObject({ ok: true });
  });

  it("returns error when maxDurationWeeks is negative", () => {
    expect(validateUpsertVolunteerInput({ ...BASE_INPUT, maxDurationWeeks: -1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("negativa"),
    });
  });

  it("returns ok when maxDurationWeeks is 0", () => {
    expect(validateUpsertVolunteerInput({ ...BASE_INPUT, maxDurationWeeks: 0 })).toMatchObject({
      ok: true,
    });
  });

  it("returns ok when maxDurationWeeks is positive", () => {
    expect(validateUpsertVolunteerInput({ ...BASE_INPUT, maxDurationWeeks: 12 })).toMatchObject({
      ok: true,
    });
  });

  it("returns ok when maxDurationWeeks is null", () => {
    expect(validateUpsertVolunteerInput({ ...BASE_INPUT, maxDurationWeeks: null })).toMatchObject({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Slot math
// ---------------------------------------------------------------------------

describe("computeNewSlots", () => {
  // INSERT branch — no existing row.
  it("INSERT: returns 1 for mode=enroll", () => {
    expect(computeNewSlots({ existing: null, mode: "enroll" })).toBe(1);
  });

  it("INSERT: returns 0 for mode=update_preferences_only", () => {
    expect(computeNewSlots({ existing: null, mode: "update_preferences_only" })).toBe(0);
  });

  // UPDATE branch — withdrawn → re-enroll.
  it("UPDATE: withdrawn + enroll → 1", () => {
    expect(
      computeNewSlots({
        existing: { status: "withdrawn", availableSlots: 0 },
        mode: "enroll",
      }),
    ).toBe(1);
  });

  it("UPDATE: withdrawn + update_preferences_only → 0", () => {
    expect(
      computeNewSlots({
        existing: { status: "withdrawn", availableSlots: 0 },
        mode: "update_preferences_only",
      }),
    ).toBe(0);
  });

  // UPDATE branch — active → enroll adds 1.
  it("UPDATE: active with 2 slots + enroll → 3", () => {
    expect(
      computeNewSlots({
        existing: { status: "active", availableSlots: 2 },
        mode: "enroll",
      }),
    ).toBe(3);
  });

  // UPDATE branch — active + update_preferences_only leaves slots unchanged.
  it("UPDATE: active with 2 slots + update_preferences_only → 2", () => {
    expect(
      computeNewSlots({
        existing: { status: "active", availableSlots: 2 },
        mode: "update_preferences_only",
      }),
    ).toBe(2);
  });

  // UPDATE branch — paused behaves like active (not withdrawn).
  it("UPDATE: paused with 1 slot + enroll → 2", () => {
    expect(
      computeNewSlots({
        existing: { status: "paused", availableSlots: 1 },
        mode: "enroll",
      }),
    ).toBe(2);
  });
});
