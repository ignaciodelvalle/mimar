// @vitest-environment jsdom
//
// CoFosterToggle — toast-sweep-2026-07-21: a Tier B optimistic toggle that
// used to have zero explicit success feedback (only the button highlight
// flipped). Pins that a successful toggle fires notifySaved and a failed
// toggle reverts + surfaces the inline error WITHOUT toasting (double-signal
// avoided — mutation-feedback convention, lib/ui/action-feedback.ts).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const setCoFosterAllowedAction = vi.fn();
vi.mock("@/src/modules/foster/actions", () => ({
  setCoFosterAllowedAction: (...args: unknown[]) => setCoFosterAllowedAction(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { CoFosterToggle } from "./CoFosterToggle";

beforeEach(() => {
  setCoFosterAllowedAction.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

it("fires the success toast after allowing co-foster", async () => {
  setCoFosterAllowedAction.mockResolvedValue({ ok: true });
  render(<CoFosterToggle fosterOwnershipId="fo-1" initial={false} />);

  fireEvent.click(screen.getByRole("button", { name: "Permitir" }));

  await waitFor(() => {
    expect(setCoFosterAllowedAction).toHaveBeenCalledWith({
      fosterOwnershipId: "fo-1",
      allowCoFoster: true,
    });
  });
  expect(toastSuccess).toHaveBeenCalledWith("Ahora permitís co-foster");
});

it("reverts and shows the inline error without toasting when the toggle fails", async () => {
  setCoFosterAllowedAction.mockResolvedValue({ error: "No se pudo actualizar." });
  render(<CoFosterToggle fosterOwnershipId="fo-1" initial={false} />);

  fireEvent.click(screen.getByRole("button", { name: "Permitir" }));

  await waitFor(() => {
    expect(screen.getByText("No se pudo actualizar.")).toBeInTheDocument();
  });
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(toastError).not.toHaveBeenCalled();
});
