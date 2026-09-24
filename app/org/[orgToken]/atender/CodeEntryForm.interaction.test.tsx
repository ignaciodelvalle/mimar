// @vitest-environment jsdom
//
// A3 interaction test: after a failed DIM-code lookup the error alert must be
// cleared as soon as the operator edits the code, so a fresh attempt starts
// clean. Exercises the REAL useActionState + useState/useEffect chain via RTL.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The redirect hook fires a full-document nav on success; stub the nav so the
// (error-only) test never touches window.location.
const navigateMock = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateMock(url),
}));

import { CodeEntryForm } from "./CodeEntryForm";

const LOOKUP_ERROR = "No encontramos una mascota con ese código.";

beforeEach(() => {
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<CodeEntryForm> — A3 stale-error clearing", () => {
  it("shows the lookup error after a failed submit, then clears it on edit", async () => {
    // Fresh object per call so React 19's useActionState always commits (a
    // shared reference can make it bail the second update and stick pending).
    const action = vi.fn(async () => ({ error: LOOKUP_ERROR }));

    render(<CodeEntryForm action={action} />);

    const input = screen.getByLabelText(/Código de la credencial/i);
    fireEvent.change(input, { target: { value: "DIM-0000-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar mascota" }));

    // The failed attempt surfaces the alert.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(LOOKUP_ERROR);
    });

    // Editing the code clears the stale error immediately — fresh attempt.
    fireEvent.change(input, { target: { value: "DIM-1234-5678" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-arms the alert when a second attempt also fails", async () => {
    const action = vi.fn(async () => ({ error: LOOKUP_ERROR }));

    render(<CodeEntryForm action={action} />);

    const input = screen.getByLabelText(/Código de la credencial/i);
    const submit = screen.getByRole("button", { name: "Buscar mascota" });

    fireEvent.change(input, { target: { value: "DIM-0000-0000" } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // Edit clears it...
    fireEvent.change(input, { target: { value: "DIM-9999-9999" } });
    expect(screen.queryByRole("alert")).toBeNull();

    // ...and a second failed submit shows the error again.
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOOKUP_ERROR));
  });
});
