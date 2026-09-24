// @vitest-environment jsdom
//
// MicrochipRequiredForm's `notes` had a STATIC defaultValue={initialNotes}
// — a rejected submit (a duplicate rule, a validation error) put back the
// row's ORIGINAL notes, discarding whatever the operator had just typed.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

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

import { MicrochipRequiredForm } from "./MicrochipRequiredForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialRequired: false,
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<MicrochipRequiredForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<MicrochipRequiredForm {...BASE_PROPS} />);

    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(notes, { target: { value: "Exigencia agregada tras ordenanza local." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Exigencia agregada tras ordenanza local.",
    );
  });
});
