// Unit tests for dismissFirstStepAction — the auth + revalidation half of
// the "Primeros pasos" dismiss contract (business logic is tested in
// src/modules/pets/application/profile/dismiss-first-step.test.ts;
// framework-free per ADR 2026-07-18 native-readiness).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequirePetAccess, mockDismissFirstStep, mockRevalidatePath } = vi.hoisted(() => ({
  mockRequirePetAccess: vi.fn(),
  mockDismissFirstStep: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: mockRequirePetAccess,
}));

vi.mock("@/src/modules/pets/application/profile/dismiss-first-step", () => ({
  dismissFirstStep: mockDismissFirstStep,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import { dismissFirstStepAction } from "./pet-onboarding";

describe("dismissFirstStepAction", () => {
  beforeEach(() => {
    mockRequirePetAccess.mockReset();
    mockDismissFirstStep.mockReset();
    mockRevalidatePath.mockReset();
  });

  it("revalidates the pet profile path when a row was written", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: true, pet: { id: "pet-1" } });
    mockDismissFirstStep.mockResolvedValue(true);

    await dismissFirstStepAction("DIM-PAMP-0001", "photo");

    expect(mockDismissFirstStep).toHaveBeenCalledWith("pet-1", "photo");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/mis-mascotas/DIM-PAMP-0001");
  });

  it("does NOT revalidate when the write was a no-op (already dismissed)", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: true, pet: { id: "pet-1" } });
    mockDismissFirstStep.mockResolvedValue(false);

    await dismissFirstStepAction("DIM-PAMP-0001", "photo");

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("throws before touching the use-case when access is denied", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: false, error: "not-found-or-forbidden" });

    await expect(dismissFirstStepAction("DIM-PAMP-0001", "photo")).rejects.toThrow();
    expect(mockDismissFirstStep).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
