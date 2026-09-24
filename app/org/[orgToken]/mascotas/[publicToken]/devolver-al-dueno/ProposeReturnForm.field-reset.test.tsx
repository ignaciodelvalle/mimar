// @vitest-environment jsdom
//
// ProposeReturnForm's "notes" (step 3 of the wizard) is a bare uncontrolled
// field — a rejected submit wipes it right when the org is about to send
// the proposal.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/return-to-owner-form", () => ({
  proposeReturnToOwnerFormAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, orgToken: string, petPublicToken: string) =>
      (...args: unknown[]) =>
        actionMock(orgToken, petPublicToken, ...args),
  }),
}));

import { ProposeReturnForm } from "./ProposeReturnForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<ProposeReturnForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo enviar la propuesta." });
    const { container } = render(
      <ProposeReturnForm
        orgToken="ORG-TEST-0001"
        petPublicToken="DIM-TEST-0001"
        petName="Firulais"
      />,
    );

    fireEvent.click(screen.getAllByText("Continuar")[0]);
    fireEvent.click(screen.getAllByText("Continuar")[0]);

    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(notes, { target: { value: "Coordinamos entrega el sábado a las 10." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo enviar la propuesta.");

    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Coordinamos entrega el sábado a las 10.",
    );
  });
});
