// Unit test for the STUB_CLAIM_ENABLED security gate (review 2026-05-19 §2.1).
//
// While the gate is OFF, claimStubProfileAction MUST return the friendly
// pausado error before reaching Supabase auth or any DB call. The downstream
// transaction/merge logic stays in place for re-enabling later, but every
// reachable code path while the gate is off ends with the gate's return.
//
// This test calls the action directly with empty FormData and asserts the
// gate's exact error message. No Supabase, no DB interaction.

import { describe, expect, it } from "vitest";

import { claimStubProfileAction } from "@/app/actions/claim";

describe("claimStubProfileAction — STUB_CLAIM_ENABLED gate (§2.1)", () => {
  it("returns the pausado error and does not touch DB or Supabase while the gate is off", async () => {
    const formData = new FormData();
    formData.set("dni", "12345678");

    const result = await claimStubProfileAction({ error: null }, formData);

    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/pausado/i);
    expect(result.error).toMatch(/Mi Argentina/i);
  });

  it("returns the pausado error even when the form is empty (gate runs before any validation)", async () => {
    const result = await claimStubProfileAction({ error: null }, new FormData());

    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/pausado/i);
  });
});
