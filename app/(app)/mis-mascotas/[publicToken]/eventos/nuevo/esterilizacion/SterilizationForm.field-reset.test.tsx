// @vitest-environment jsdom
//
// SterilizationForm's "procedure" radio group had a STATIC defaultChecked
// derived from `defaults` — a rejected submit puts back the ORIGINAL
// default, discarding whichever procedure was actually picked.
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

import { SterilizationForm } from "./SterilizationForm";

afterEach(cleanup);

describe("<SterilizationForm> — survives the React 19 post-error reset", () => {
  it("keeps the ticked procedure after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar la esterilización." }));
    const { container } = render(
      <SterilizationForm action={action} defaults={{ occurredAt: null, notes: null }} />,
    );

    const spay = container.querySelector(
      'input[name="procedure"][value="spay"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(spay);
    expect(spay.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la esterilización.");

    expect(
      (container.querySelector('input[name="procedure"][value="spay"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});
