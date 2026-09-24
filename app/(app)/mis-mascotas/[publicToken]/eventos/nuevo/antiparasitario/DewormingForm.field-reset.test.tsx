// @vitest-environment jsdom
//
// DewormingForm's "type" is an uncontrolled radio group with no
// defaultChecked at all — a rejected submit leaves every option unticked,
// discarding whichever type was picked. Every other field is genuinely
// controlled (value+onChange) and already survives on its own.
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
vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

import { DewormingForm } from "./DewormingForm";

afterEach(cleanup);

describe("<DewormingForm> — survives the React 19 post-error reset", () => {
  it("keeps the ticked type after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el antiparasitario." }));
    const { container } = render(<DewormingForm action={action} />);

    const product = container.querySelector('input[name="product"]') as HTMLInputElement;
    const external = container.querySelector(
      'input[name="type"][value="external"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // "product" is a required text field, empty at mount — jsdom enforces
    // native constraint validation, so it needs a value before
    // form.requestSubmit() will actually fire the action.
    fireEvent.change(product, { target: { value: "Frontline Plus" } });
    fireEvent.click(external);
    expect(external.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el antiparasitario.");

    expect(
      (container.querySelector('input[name="type"][value="external"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
