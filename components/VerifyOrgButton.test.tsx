// @vitest-environment jsdom
//
// VerifyOrgButton — mutation-feedback convention adoption (audit-3-feedback
// §C1, 2026-07-21): this action never reloads/navigates on success, so it's
// a representative in-place mutation for the new notifySaved toast — pins
// that the toast fires alongside the existing "admins were notified" panel
// (the panel carries substantive detail the toast doesn't repeat).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const verifyOrgAction = vi.fn();
vi.mock("@/app/actions/admin-org-verification", () => ({
  verifyOrgAction: (...args: unknown[]) => verifyOrgAction(...args),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

import { VerifyOrgButton } from "./VerifyOrgButton";

const org = { id: "org-1", displayName: "Refugio Norte", verified: false };

beforeEach(() => {
  verifyOrgAction.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

it("shows the notified panel and fires the success toast after verifying", async () => {
  verifyOrgAction.mockResolvedValue({ ok: true });
  render(<VerifyOrgButton org={org} />);

  fireEvent.click(screen.getByRole("button", { name: "Verificar organización" }));
  fireEvent.click(screen.getByRole("button", { name: "Sí, verificar" }));

  await waitFor(() => {
    expect(screen.getByText(/Organización verificada/)).toBeInTheDocument();
  });
  expect(toastSuccess).toHaveBeenCalledWith("Organización verificada");
});

it("does not toast when verification fails", async () => {
  verifyOrgAction.mockResolvedValue({ error: "Sin permisos." });
  render(<VerifyOrgButton org={org} />);

  fireEvent.click(screen.getByRole("button", { name: "Verificar organización" }));
  fireEvent.click(screen.getByRole("button", { name: "Sí, verificar" }));

  await waitFor(() => {
    expect(screen.getByText("Sin permisos.")).toBeInTheDocument();
  });
  expect(toastSuccess).not.toHaveBeenCalled();
});
