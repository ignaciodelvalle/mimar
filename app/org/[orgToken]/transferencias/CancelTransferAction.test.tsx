// @vitest-environment jsdom
//
// CancelTransferAction — E4 (2026-07-21 facades harvest). Pins that the
// sender-side cancel control (a) shows consequence copy in a ConfirmDialog
// before firing, (b) calls cancelCrossOrgTransferAction with the right
// scoping args, and (c) surfaces a server error without a false success toast.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cancelCrossOrgTransferAction = vi.fn();
vi.mock("@/src/modules/transfers/actions", () => ({
  cancelCrossOrgTransferAction: (...args: unknown[]) => cancelCrossOrgTransferAction(...args),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

// jsdom doesn't implement native <dialog>.showModal/close — same stub as
// IncomingTransferActions.test.tsx.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

import { CancelTransferAction } from "./CancelTransferAction";

const props = { senderOrgToken: "org-1", casePublicCode: "DC-0001", petName: "Firulais" };

beforeEach(() => {
  cancelCrossOrgTransferAction.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CancelTransferAction", () => {
  it("opens a ConfirmDialog naming the consequence, and confirms through it", async () => {
    cancelCrossOrgTransferAction.mockResolvedValue({ ok: true });
    render(<CancelTransferAction {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar transferencia" }));
    const dialog = screen.getByRole("dialog", { name: "Cancelar propuesta de transferencia" });
    expect(
      within(dialog).getByText(/cancela la propuesta de transferir la custodia de Firulais/),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar transferencia" }));

    await waitFor(() => {
      expect(cancelCrossOrgTransferAction).toHaveBeenCalledWith({
        senderOrgToken: "org-1",
        casePublicCode: "DC-0001",
      });
    });
    expect(screen.getByText("Transferencia cancelada.")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Transferencia cancelada");
  });

  it("cancelling the dialog does not call the action", () => {
    render(<CancelTransferAction {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar transferencia" }));
    const dialog = screen.getByRole("dialog", { name: "Cancelar propuesta de transferencia" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Volver" }));

    expect(cancelCrossOrgTransferAction).not.toHaveBeenCalled();
  });

  it("shows the server error and does not toast when cancel fails", async () => {
    cancelCrossOrgTransferAction.mockResolvedValue({ error: "Este caso ya no está abierto." });
    render(<CancelTransferAction {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar transferencia" }));
    const dialog = screen.getByRole("dialog", { name: "Cancelar propuesta de transferencia" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar transferencia" }));

    await waitFor(() => {
      expect(screen.getByText("Este caso ya no está abierto.")).toBeInTheDocument();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
