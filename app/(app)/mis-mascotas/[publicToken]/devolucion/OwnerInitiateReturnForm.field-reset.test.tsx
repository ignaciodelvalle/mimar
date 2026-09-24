// @vitest-environment jsdom
//
// OwnerInitiateReturnForm's "reason" <select> was bare uncontrolled
// (`defaultValue=""`, no `value=`/`onChange=`) — a rejected submit falls it
// back to its first (disabled) option, discarding the reason the owner
// picked. "notes" and "proposedAt" are genuinely controlled and already
// survive on their own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/return-to-owner-form", () => ({
  ownerProposeReturnToOrgFormAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, petPublicToken: string) =>
      (...args: unknown[]) =>
        actionMock(petPublicToken, ...args),
  }),
}));

import { OwnerInitiateReturnForm } from "./OwnerInitiateReturnForm";

const BASE_PROPS = {
  petPublicToken: "DIM-TEST-0001",
  petName: "Firulais",
  orgDisplayName: "Refugio Norte",
  backUrl: "/mis-mascotas",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<OwnerInitiateReturnForm> — survives the React 19 post-error reset", () => {
  it("keeps the picked reason after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo enviar la propuesta." });
    const { container } = render(<OwnerInitiateReturnForm {...BASE_PROPS} />);

    const reason = container.querySelector('select[name="reason"]') as HTMLSelectElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(reason, { target: { value: "space_constraint" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo enviar la propuesta.");

    expect((container.querySelector('select[name="reason"]') as HTMLSelectElement).value).toBe(
      "space_constraint",
    );
  });
});
