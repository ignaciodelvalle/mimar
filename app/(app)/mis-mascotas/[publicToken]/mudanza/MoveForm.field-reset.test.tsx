// @vitest-environment jsdom
//
// MoveForm's "reason" is a bare uncontrolled field — a rejected submit
// (e.g. a server-side validation error) wipes it.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));

import { MoveForm } from "./MoveForm";

afterEach(cleanup);

describe("<MoveForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed reason after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar la mudanza." }));
    const { container } = render(
      <MoveForm
        action={action}
        petName="Firulais"
        currentProvince="Buenos Aires"
        currentLocality="Palermo"
      />,
    );

    const reason = container.querySelector('input[name="reason"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(reason, { target: { value: "Cambio de tenencia a mi hermana." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la mudanza.");

    expect((container.querySelector('input[name="reason"]') as HTMLInputElement).value).toBe(
      "Cambio de tenencia a mi hermana.",
    );
  });
});
