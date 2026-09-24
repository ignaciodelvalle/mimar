// @vitest-environment jsdom
//
// PppWeightThresholdForm's `appliesIfBreedNotPPP` checkbox was controlled
// with checked=/onChange= — the exact pair react19-form-reset-contract.test.tsx
// measures as vulnerable regardless. `notes` had a STATIC defaultValue. `kg`
// is already controlled (value+onChange) and survives on its own.
//
// Real submit via `form.requestSubmit()` — see that file for why a
// dispatched event does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/business-rules", () => ({
  createBusinessRuleAction: (...args: unknown[]) => actionMock(...args),
  updateBusinessRuleAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, ruleId: string) =>
      (...args: unknown[]) =>
        actionMock(ruleId, ...args),
  }),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

// RuleImpactBanner previews an affected-pet count via a server action —
// irrelevant to this fix and mocked out (same technique as LocationFields
// elsewhere).
vi.mock("@/app/actions/rule-impact-preview", () => ({
  previewRuleImpact: vi.fn(async () => ({ affectedCount: 0 })),
}));

import { PppWeightThresholdForm } from "./PppWeightThresholdForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialKg: null,
  initialAppliesIfBreedNotPPP: false,
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<PppWeightThresholdForm> — survives the React 19 post-error reset", () => {
  it("keeps the ticked checkbox and the notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<PppWeightThresholdForm {...BASE_PROPS} />);

    const appliesCheckbox = container.querySelector(
      'input[name="appliesIfBreedNotPPP"]',
    ) as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(appliesCheckbox);
    expect(appliesCheckbox.checked).toBe(true);
    fireEvent.change(notes, { target: { value: "Aplica a todas las razas por peso." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect(
      (container.querySelector('input[name="appliesIfBreedNotPPP"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Aplica a todas las razas por peso.",
    );
  });
});
