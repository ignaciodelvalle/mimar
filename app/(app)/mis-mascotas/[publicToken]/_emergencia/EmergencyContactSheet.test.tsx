// @vitest-environment jsdom
//
// EmergencyContactSheet — mutation-feedback convention adoption
// (audit-3-feedback §C1, 2026-07-21): this sheet stays mounted after a
// successful save (no reload), so it's a representative in-place mutation
// for the new notifySaved toast — pins that the toast fires alongside the
// existing "Guardado." inline output rather than replacing it.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateEmergencyContactsAction = vi.fn();
vi.mock("@/app/actions/profile", () => ({
  updateEmergencyContactsAction: (...args: unknown[]) => updateEmergencyContactsAction(...args),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

import { EmergencyContactSheet } from "./EmergencyContactSheet";

const initialValues = {
  preferredVetName: "",
  preferredVetPhone: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
};

beforeEach(() => {
  updateEmergencyContactsAction.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("EmergencyContactSheet — save feedback", () => {
  it("shows the inline 'Guardado.' output and fires the success toast", async () => {
    updateEmergencyContactsAction.mockResolvedValue({ ok: true });
    render(<EmergencyContactSheet petPublicToken="DIM-0001" initialValues={initialValues} />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(screen.getByText("Guardado.")).toBeInTheDocument();
    });
    expect(toastSuccess).toHaveBeenCalledWith("Se guardó");
  });

  it("does not toast when the save fails", async () => {
    updateEmergencyContactsAction.mockResolvedValue({ error: "No se pudo guardar." });
    render(<EmergencyContactSheet petPublicToken="DIM-0001" initialValues={initialValues} />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(screen.getByText("No se pudo guardar.")).toBeInTheDocument();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
