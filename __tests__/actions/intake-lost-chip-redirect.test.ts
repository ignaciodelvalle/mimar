// Org intake, chip matches a LOST pet: the use-case must REPORT where to go,
// not navigate (nav contract N3 + native-readiness T1.3).
//
// WHY THIS IS A BUG FIX AND NOT ONLY A REFACTOR
// ---------------------------------------------------------------------------
// createIntake used to call next/navigation `redirect()` here. Next 15.5.x's
// App Router drops a Server Action's own redirect intermittently in production
// (lib/ui/full-page-action-nav.ts documents the mechanism), so the operator
// pressed "Crear ingreso" on a chip belonging to somebody's lost dog and, some
// of the time, watched nothing happen at all — on the one intake path where
// stopping the operator actually matters, because the animal in front of them
// is already registered as lost by a family looking for it.
//
// Returning `redirectTo` also cuts the last next/navigation import out of the
// use-case, which is what lets it leave the application-layer fence's
// exemption list and be callable from something that is not a Next request.
//
// lookupByChip and the claim generator are mocked: this asserts the CONTROL
// FLOW at the match, not the chip index or the HMAC (both have their own tests
// in __tests__/chip-match.test.ts and lib/infra/intake-match-claim).

import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupByChip = vi.fn();
vi.mock("@/lib/infra/chip-lookup", () => ({
  lookupByChip: (...args: unknown[]) => lookupByChip(...args),
}));
vi.mock("@/lib/infra/intake-match-claim", () => ({
  generateIntakeMatchClaim: () => "CLAIM-STUB",
  validateIntakeMatchClaim: () => ({ ok: true }),
}));

import { createIntake } from "@/src/modules/pets/application/intake/create-intake";

const USER = { id: "00000000-0000-0000-0000-000000000001" };
const ORG = {
  id: "00000000-0000-0000-0000-000000000002",
  displayName: "Refugio Test",
  verified: true,
};

// ISO 11784/11785: 15 digits.
const CHIP = "900123456789012";
const MATCHED_TOKEN = "DIM-LOST-0001";

function intakeFormData(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("name", "Sin nombre");
  fd.set("species", "dog");
  fd.set("intakeReason", "rescue");
  fd.set("microchipId", CHIP);
  for (const [k, v] of Object.entries(overrides ?? {})) fd.set(k, v);
  return fd;
}

describe("createIntake — chip matches a lost pet", () => {
  beforeEach(() => {
    lookupByChip.mockReset();
  });

  it("returns redirectTo for the match page instead of navigating", async () => {
    lookupByChip.mockResolvedValue({
      pet: { status: "lost", publicToken: MATCHED_TOKEN, ownerUserId: "owner-1" },
    });

    const result = await createIntake("ORGTOK", USER, ORG, intakeFormData());

    expect(result.error).toBeNull();
    expect(result.redirectTo).toBe(
      `/org/ORGTOK/intake/match/${MATCHED_TOKEN}?claim=${encodeURIComponent("CLAIM-STUB")}`,
    );
    // Nothing was created, so the form must not flip to its success screen.
    expect(result.ok).toBeUndefined();
  });

  it("still hard-blocks an ACTIVE chip match with copy, not a destination", async () => {
    // The neighbouring branch, asserted here so a refactor of one cannot
    // quietly turn the other into a navigation.
    lookupByChip.mockResolvedValue({
      pet: { status: "active", publicToken: MATCHED_TOKEN, ownerUserId: "owner-1" },
    });

    const result = await createIntake("ORGTOK", USER, ORG, intakeFormData());

    expect(result.redirectTo).toBeUndefined();
    expect(result.error).toContain("Este microchip ya está registrado");
  });

  it("does not throw NEXT_REDIRECT — the use-case performs no navigation", async () => {
    lookupByChip.mockResolvedValue({
      pet: { status: "lost", publicToken: MATCHED_TOKEN, ownerUserId: null },
    });

    await expect(createIntake("ORGTOK", USER, ORG, intakeFormData())).resolves.toBeDefined();
  });
});
