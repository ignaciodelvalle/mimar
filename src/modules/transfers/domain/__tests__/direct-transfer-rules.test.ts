// Unit tests for direct-transfer-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.4) before creating direct-transfer-rules.ts.

import { describe, expect, it } from "vitest";

import {
  resolveNewRole,
  validateDestinationNotSource,
  validateTransferableSourceRole,
} from "../direct-transfer-rules";

// ---------------------------------------------------------------------------
// validateTransferableSourceRole
// ---------------------------------------------------------------------------

describe("validateTransferableSourceRole", () => {
  it("passes for 'shelter_custody'", () => {
    expect(validateTransferableSourceRole("shelter_custody")).toMatchObject({ ok: true });
  });

  it("passes for 'owner'", () => {
    expect(validateTransferableSourceRole("owner")).toMatchObject({ ok: true });
  });

  it("fails for 'foster' with correct error", () => {
    expect(validateTransferableSourceRole("foster")).toMatchObject({
      ok: false,
      error: expect.stringContaining("foster"),
    });
  });

  it("fails for an unknown role", () => {
    expect(validateTransferableSourceRole("unknown_role")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// resolveNewRole — silent coercion to shelter_custody (quirk preserved)
// ---------------------------------------------------------------------------

describe("resolveNewRole", () => {
  it("returns 'shelter_custody' for valid 'shelter_custody'", () => {
    expect(resolveNewRole("shelter_custody")).toBe("shelter_custody");
  });

  it("returns 'owner' for valid 'owner'", () => {
    expect(resolveNewRole("owner")).toBe("owner");
  });

  it("silently falls back to 'shelter_custody' for invalid role (parity quirk)", () => {
    // The old code does NOT return an error for invalid newRole — it silently
    // coerces to shelter_custody. Preserve this flag-without-error behavior.
    expect(resolveNewRole("invalid_role")).toBe("shelter_custody");
  });

  it("silently falls back to 'shelter_custody' for empty string", () => {
    expect(resolveNewRole("")).toBe("shelter_custody");
  });
});

// ---------------------------------------------------------------------------
// validateDestinationNotSource
// ---------------------------------------------------------------------------

describe("validateDestinationNotSource", () => {
  it("passes when destination and source are different orgs", () => {
    expect(validateDestinationNotSource("org-a", "org-b")).toMatchObject({ ok: true });
  });

  it("fails when destination equals source org", () => {
    expect(validateDestinationNotSource("org-a", "org-a")).toMatchObject({
      ok: false,
      error: expect.stringContaining("destino"),
    });
  });
});
