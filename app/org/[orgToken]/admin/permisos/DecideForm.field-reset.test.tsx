// @vitest-environment jsdom
//
// DecideForm's "reason" is a bare uncontrolled field — a rejected submit
// wipes it.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  decideCapabilityAction: (...args: unknown[]) => actionMock(...args),
}));

import { DecideForm } from "./DecideForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<DecideForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed reason after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo registrar la decisión." });
    const { container } = render(
      <DecideForm orgToken="ORG-TEST-0001" grantId="grant-1" pending={true} approved={false} />,
    );

    fireEvent.click(screen.getByText("Aprobar"));

    const reason = container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(reason, { target: { value: "Cumple con los requisitos del reglamento." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la decisión.");

    expect((container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement).value).toBe(
      "Cumple con los requisitos del reglamento.",
    );
  });
});
