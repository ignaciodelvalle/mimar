// @vitest-environment jsdom
//
// AgendaRuleForm's "daysOfWeek" checkboxes had a STATIC defaultChecked
// derived from `defaultDays`/`d.value` — a rejected submit put back the
// ORIGINAL defaults, discarding whichever days the org had actually
// ticked. The checkbox carried an ordinary React list `key={d.value}` but
// no `onChange`, so the expression never reflected a real click.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaRuleForm } from "./AgendaRuleForm";

const actionMock = vi.fn();

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<AgendaRuleForm> — survives the React 19 post-error reset", () => {
  it("keeps the ticked days after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(
      <AgendaRuleForm
        serviceOfferingId="offering-1"
        offeringPublicToken="OFF-TEST-0001"
        orgToken="ORG-TEST-0001"
        createAction={actionMock}
      />,
    );

    // Sat (6) is unticked by default (default is days 1-5). Tick it so its
    // post-submit state differs from its mount default.
    const sat = container.querySelector('input[name="daysOfWeek"][value="6"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(sat);
    expect(sat.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect(
      (container.querySelector('input[name="daysOfWeek"][value="6"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
