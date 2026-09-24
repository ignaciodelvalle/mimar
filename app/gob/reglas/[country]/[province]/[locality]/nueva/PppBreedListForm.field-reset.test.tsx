// @vitest-environment jsdom
//
// PppBreedListForm's `breeds` checkbox group was controlled with
// checked=/onChange= — the exact pair react19-form-reset-contract.test.tsx
// measures as vulnerable regardless (falls back to its MOUNT selection).
// `notes` had a STATIC defaultValue.
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

import { PppBreedListForm } from "./PppBreedListForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialBreeds: [],
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<PppBreedListForm> — survives the React 19 post-error reset", () => {
  it("keeps a ticked breed and the notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<PppBreedListForm {...BASE_PROPS} />);

    const rottweiler = container.querySelector(
      'input[name="breeds"][value="Rottweiler"]',
    ) as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(rottweiler);
    expect(rottweiler.checked).toBe(true);
    fireEvent.change(notes, { target: { value: "Agregada tras denuncia PPP recurrente." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect(
      (container.querySelector('input[name="breeds"][value="Rottweiler"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Agregada tras denuncia PPP recurrente.",
    );
  });
});
