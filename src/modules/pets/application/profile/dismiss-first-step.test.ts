// Unit tests — dismissFirstStep use-case ("Primeros pasos" onboarding checklist).
// Framework-free (ADR 2026-07-18 native-readiness): revalidation is the
// caller's (actions layer) job — see app/actions/pet-onboarding.test.ts for
// that half of the contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

let selectRow: { dismissed: string[] } | null = null;
let updateSetCalls: Record<string, unknown>[] = [];

vi.mock("@/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (selectRow ? [selectRow] : []),
  };
  const updateChain = {
    set: (values: Record<string, unknown>) => {
      updateSetCalls.push(values);
      return updateChain;
    },
    where: async () => {},
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
    },
    pets: { id: "pets.id", dismissedFirstSteps: "pets.dismissed_first_steps" },
  };
});

import { dismissFirstStep } from "./dismiss-first-step";

describe("dismissFirstStep", () => {
  beforeEach(() => {
    selectRow = { dismissed: [] };
    updateSetCalls = [];
  });

  it("writes the step key and returns true (caller should revalidate)", async () => {
    const wrote = await dismissFirstStep("pet-1", "photo");

    expect(updateSetCalls).toHaveLength(1);
    expect(wrote).toBe(true);
  });

  it("is idempotent: dismissing an already-dismissed key is a no-op (no write, returns false)", async () => {
    selectRow = { dismissed: ["photo"] };

    const wrote = await dismissFirstStep("pet-1", "photo");

    expect(updateSetCalls).toHaveLength(0);
    expect(wrote).toBe(false);
  });

  it("does nothing for an unknown pet (stale submit)", async () => {
    selectRow = null;

    const wrote = await dismissFirstStep("pet-1", "photo");

    expect(updateSetCalls).toHaveLength(0);
    expect(wrote).toBe(false);
  });
});
