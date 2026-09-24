// @vitest-environment jsdom
//
// ReplaceMicrochipForm's "reason" is an uncontrolled radio group with no
// defaultChecked at all — a rejected submit leaves every option unticked,
// discarding whichever reason was picked.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(() => false),
}));
vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

import { ReplaceMicrochipForm } from "./ReplaceMicrochipForm";

afterEach(cleanup);

describe("<ReplaceMicrochipForm> — survives the React 19 post-error reset", () => {
  it("keeps the ticked reason after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el reemplazo." }));
    const { container } = render(
      <ReplaceMicrochipForm action={action} currentChip="985141004321456" />,
    );

    const unreadable = container.querySelector(
      'input[name="reason"][value="unreadable"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(unreadable);
    expect(unreadable.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el reemplazo.");

    expect(
      (container.querySelector('input[name="reason"][value="unreadable"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});
