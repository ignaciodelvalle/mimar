// @vitest-environment jsdom
//
// CodeEntryForm's "code" is a bare uncontrolled field — a rejected lookup
// (e.g. code not found) wipes what the vet typed.
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

import { CodeEntryForm } from "./CodeEntryForm";

afterEach(cleanup);

describe("<CodeEntryForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed code after a rejected lookup", async () => {
    const action = vi.fn(async () => ({ error: "No encontramos esa credencial." }));
    const { container } = render(<CodeEntryForm action={action} />);

    const code = container.querySelector('input[name="code"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(code, { target: { value: "DIM-TEST-0001" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No encontramos esa credencial.");

    expect((container.querySelector('input[name="code"]') as HTMLInputElement).value).toBe(
      "DIM-TEST-0001",
    );
  });
});
