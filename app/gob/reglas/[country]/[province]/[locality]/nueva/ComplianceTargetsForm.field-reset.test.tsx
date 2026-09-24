// @vitest-environment jsdom
//
// ComplianceTargetsForm's PCT_FIELDS and `notes` had a STATIC defaultValue
// derived from `initialPayload`/`initialNotes` — a rejected submit put back
// the row's ORIGINAL values, discarding whatever the operator had just
// typed.
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

import { ComplianceTargetsForm } from "./ComplianceTargetsForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialPayload: {},
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<ComplianceTargetsForm> — survives the React 19 post-error reset", () => {
  it("keeps a typed percentage target and the notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<ComplianceTargetsForm {...BASE_PROPS} />);

    const pct = container.querySelector('input[name="rabies_coverage_pct"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(pct, { target: { value: "72.5" } });
    fireEvent.change(notes, { target: { value: "Meta ajustada tras la campaña 2026." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect(
      (container.querySelector('input[name="rabies_coverage_pct"]') as HTMLInputElement).value,
    ).toBe("72.5");
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Meta ajustada tras la campaña 2026.",
    );
  });
});
