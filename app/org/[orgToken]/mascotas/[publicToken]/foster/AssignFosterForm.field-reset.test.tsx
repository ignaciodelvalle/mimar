// @vitest-environment jsdom
//
// AssignFosterForm's "fosterUserId" is an uncontrolled <select> — a
// rejected submit falls it back to its first (disabled) option, discarding
// whichever volunteer was picked. "expectedWeeks" and "notes" are genuinely
// controlled (value+onChange) and already survive on their own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/foster/actions", () => ({
  assignFosterAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, orgToken: string, publicToken: string) =>
      (...args: unknown[]) =>
        actionMock(orgToken, publicToken, ...args),
  }),
}));

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));

import { AssignFosterForm } from "./AssignFosterForm";

const CANDIDATES = [
  { userId: "user-1", displayName: "Ana", role: "member" },
  { userId: "user-2", displayName: "Beto", role: "volunteer" },
];

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<AssignFosterForm> — survives the React 19 post-error reset", () => {
  it("keeps the picked volunteer after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo asignar el tránsito." });
    const { container } = render(
      <AssignFosterForm
        orgToken="ORG-TEST-0001"
        publicToken="DIM-TEST-0001"
        candidates={CANDIDATES}
      />,
    );

    const fosterSelect = container.querySelector(
      'select[name="fosterUserId"]',
    ) as HTMLSelectElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(fosterSelect, { target: { value: "user-2" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo asignar el tránsito.");

    expect(
      (container.querySelector('select[name="fosterUserId"]') as HTMLSelectElement).value,
    ).toBe("user-2");
  });
});
