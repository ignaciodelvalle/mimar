// Unit tests for lib/infra/gob-onboarding-checklist.ts — T4-O3, the /gob
// first-run onboarding checklist (G1-G5).
//
// Coverage:
//   1. deriveOnboardingSteps — all five steps always present, in doc order.
//   2. Each step's done/pending flips ONLY on its own input field — no
//      cross-talk between steps (the mutation this guards against: a step
//      that reads the wrong flag and still happens to render green today).
//   3. G1 (scope) never carries an href/cta — informational, no destination.
//   4. isOnboardingComplete — true only when every step is done.
//   5. firstPendingOnboardingStep — skips a pending step with no href/cta
//      (G1), returns null once nothing focusable is left.
//
// Pure unit tests — no DB access required.

import { describe, expect, it } from "vitest";

import {
  type GobOnboardingInput,
  deriveOnboardingSteps,
  firstPendingOnboardingStep,
  isOnboardingComplete,
} from "@/lib/infra/gob-onboarding-checklist";

const ALL_FALSE: GobOnboardingInput = {
  hasSeenGobHomeBefore: false,
  hasVisitedCola: false,
  hasVisitedPanorama: false,
  hasCampaignsInScope: false,
  hasVisitedCasos: false,
  hasExportActivity: false,
};

const ALL_TRUE: GobOnboardingInput = {
  hasSeenGobHomeBefore: true,
  hasVisitedCola: true,
  hasVisitedPanorama: true,
  hasCampaignsInScope: true,
  hasVisitedCasos: true,
  hasExportActivity: true,
};

function makeInput(overrides: Partial<GobOnboardingInput> = {}): GobOnboardingInput {
  return { ...ALL_FALSE, ...overrides };
}

describe("deriveOnboardingSteps — shape", () => {
  it("always returns exactly six steps, G1-G5 order plus 'approvals' right after G1", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    expect(steps.map((s) => s.key)).toEqual([
      "scope",
      "approvals",
      "panorama",
      "campaigns",
      "casos",
      "informe",
    ]);
  });

  it("G1 (scope) carries no href/cta — informational, nowhere separate to send the operator", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    const scope = steps.find((s) => s.key === "scope");
    expect(scope?.href).toBeNull();
    expect(scope?.cta).toBeNull();
  });

  it("every other step carries a non-null href/cta", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    for (const step of steps.filter((s) => s.key !== "scope")) {
      expect(step.href).not.toBeNull();
      expect(step.cta).not.toBeNull();
    }
  });
});

describe("deriveOnboardingSteps — each step derives from its OWN input only", () => {
  it("scope.done tracks hasSeenGobHomeBefore alone", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasSeenGobHomeBefore: true }));
    expect(steps.find((s) => s.key === "scope")?.done).toBe(true);
    for (const step of steps.filter((s) => s.key !== "scope")) {
      expect(step.done).toBe(false);
    }
  });

  it("approvals.done tracks hasVisitedCola alone, and points at /gob/cola", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasVisitedCola: true }));
    const approvals = steps.find((s) => s.key === "approvals");
    expect(approvals?.done).toBe(true);
    expect(approvals?.href).toBe("/gob/cola");
    for (const step of steps.filter((s) => s.key !== "approvals")) {
      expect(step.done).toBe(false);
    }
  });

  it("panorama.done tracks hasVisitedPanorama alone", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasVisitedPanorama: true }));
    expect(steps.find((s) => s.key === "panorama")?.done).toBe(true);
    for (const step of steps.filter((s) => s.key !== "panorama")) {
      expect(step.done).toBe(false);
    }
  });

  it("campaigns.done tracks hasCampaignsInScope alone", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasCampaignsInScope: true }));
    expect(steps.find((s) => s.key === "campaigns")?.done).toBe(true);
    for (const step of steps.filter((s) => s.key !== "campaigns")) {
      expect(step.done).toBe(false);
    }
  });

  it("casos.done tracks hasVisitedCasos alone", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasVisitedCasos: true }));
    expect(steps.find((s) => s.key === "casos")?.done).toBe(true);
    for (const step of steps.filter((s) => s.key !== "casos")) {
      expect(step.done).toBe(false);
    }
  });

  it("informe.done tracks hasExportActivity alone", () => {
    const steps = deriveOnboardingSteps(makeInput({ hasExportActivity: true }));
    expect(steps.find((s) => s.key === "informe")?.done).toBe(true);
    for (const step of steps.filter((s) => s.key !== "informe")) {
      expect(step.done).toBe(false);
    }
  });
});

describe("isOnboardingComplete", () => {
  it("is false when every step is pending", () => {
    expect(isOnboardingComplete(deriveOnboardingSteps(ALL_FALSE))).toBe(false);
  });

  it("is false when only five of six steps are done", () => {
    const steps = deriveOnboardingSteps(makeInput({ ...ALL_TRUE, hasExportActivity: false }));
    expect(isOnboardingComplete(steps)).toBe(false);
  });

  it("is true only when every step is done", () => {
    expect(isOnboardingComplete(deriveOnboardingSteps(ALL_TRUE))).toBe(true);
  });
});

describe("firstPendingOnboardingStep", () => {
  it("skips G1 (no href/cta) and returns the first FOCUSABLE pending step", () => {
    // scope pending too, but it must never be returned — nothing to focus on it.
    const steps = deriveOnboardingSteps(ALL_FALSE);
    expect(firstPendingOnboardingStep(steps)?.key).toBe("approvals");
  });

  it("returns the next pending step once the earlier ones are done", () => {
    const steps = deriveOnboardingSteps(
      makeInput({ hasSeenGobHomeBefore: true, hasVisitedCola: true, hasVisitedPanorama: true }),
    );
    expect(firstPendingOnboardingStep(steps)?.key).toBe("campaigns");
  });

  it("returns null once every step is done", () => {
    expect(firstPendingOnboardingStep(deriveOnboardingSteps(ALL_TRUE))).toBeNull();
  });

  it("returns null when only the unfocusable G1 step is pending", () => {
    const steps = deriveOnboardingSteps(makeInput({ ...ALL_TRUE, hasSeenGobHomeBefore: false }));
    expect(firstPendingOnboardingStep(steps)).toBeNull();
  });
});
