// @vitest-environment jsdom
//
// DecomisoHandoffActions — the modal gate added by D.3 clase 1 (2026-07-30).
//
// Until then, accepting or rejecting a Ley 14.346 state seizure was an inline
// mode-switch panel whose primary button fired the server action directly. The
// sibling IncomingTransferActions had already been moved behind a ConfirmDialog
// for the SAME asymmetry (audit-3-feedback §C2 #3, 2026-07-21) — the fix never
// propagated here, where the custody at stake is state custody under a criminal
// statute, i.e. strictly graver than the cross-org transfer that motivated it.
//
// The load-bearing assertion in every test below is the FIRST CLICK: it must
// open a dialog and NOT call the action. A test that only checked the final
// call would still pass against the old one-click code.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const acceptDecomisoHandoffAction = vi.fn();
const rejectDecomisoHandoffAction = vi.fn();
vi.mock("@/app/actions/decomiso", () => ({
  acceptDecomisoHandoffAction: (...args: unknown[]) => acceptDecomisoHandoffAction(...args),
  rejectDecomisoHandoffAction: (...args: unknown[]) => rejectDecomisoHandoffAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

// jsdom doesn't implement native <dialog>.showModal/close — stubbed the same
// way IncomingTransferActions.test.tsx does, toggling the `open` attribute so
// RTL's role queries can see inside the dialog.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

import { DecomisoHandoffActions } from "./DecomisoHandoffActions";

const props = { receiverOrgToken: "org-1", casePublicCode: "DC-0001", petName: "Firulais" };

beforeEach(() => {
  acceptDecomisoHandoffAction.mockReset();
  rejectDecomisoHandoffAction.mockReset();
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DecomisoHandoffActions — accept (Ley 14.346 state custody)", () => {
  it("the first click opens a ConfirmDialog and does NOT take custody", () => {
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));

    expect(acceptDecomisoHandoffAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Aceptar la custodia estatal" })).toBeInTheDocument();
  });

  it("the dialog states the consequence (Ley 14.346 + irreversibility)", () => {
    render(<DecomisoHandoffActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));

    const dialog = screen.getByRole("dialog", { name: "Aceptar la custodia estatal" });
    expect(
      within(dialog).getByText(
        /Tu organización asume la custodia de Firulais bajo Ley 14\.346.*no se puede deshacer/,
      ),
    ).toBeInTheDocument();
  });

  it("confirming through the dialog calls the action once", async () => {
    acceptDecomisoHandoffAction.mockResolvedValue({ ok: true });
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));
    const dialog = screen.getByRole("dialog", { name: "Aceptar la custodia estatal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Aceptar custodia" }));

    await waitFor(() => {
      expect(acceptDecomisoHandoffAction).toHaveBeenCalledWith({
        receiverOrgToken: "org-1",
        casePublicCode: "DC-0001",
      });
    });
    expect(acceptDecomisoHandoffAction).toHaveBeenCalledTimes(1);
  });

  it("cancelling the dialog does not call the action", () => {
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));
    const dialog = screen.getByRole("dialog", { name: "Aceptar la custodia estatal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(acceptDecomisoHandoffAction).not.toHaveBeenCalled();
  });

  it("shows the server error and does not navigate when accept fails", async () => {
    acceptDecomisoHandoffAction.mockResolvedValue({ error: "El caso ya fue procesado." });
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));
    const dialog = screen.getByRole("dialog", { name: "Aceptar la custodia estatal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Aceptar custodia" }));

    await waitFor(() => {
      expect(screen.getByText("El caso ya fue procesado.")).toBeInTheDocument();
    });
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("DecomisoHandoffActions — reject (same gate as accept)", () => {
  it("the first click opens a ConfirmDialog and does NOT reject", () => {
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));

    expect(rejectDecomisoHandoffAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Rechazar la custodia estatal" });
    expect(
      within(dialog).getByText(
        /Esto devuelve el decomiso de Firulais al organismo derivante, que mantiene la custodia transitoria/,
      ),
    ).toBeInTheDocument();
  });

  it("carries the optional reason field inside the dialog and submits it", async () => {
    rejectDecomisoHandoffAction.mockResolvedValue({ ok: true });
    render(<DecomisoHandoffActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    const dialog = screen.getByRole("dialog", { name: "Rechazar la custodia estatal" });
    fireEvent.change(within(dialog).getByPlaceholderText("Motivo del rechazo (opcional)"), {
      target: { value: "Sin capacidad operativa" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rechazar custodia" }));

    await waitFor(() => {
      expect(rejectDecomisoHandoffAction).toHaveBeenCalledWith({
        receiverOrgToken: "org-1",
        casePublicCode: "DC-0001",
        reason: "Sin capacidad operativa",
      });
    });
  });
});

describe("DecomisoHandoffActions — grammar of confirmation (D.3)", () => {
  it('no button anywhere in the flow reads "Confirmar"', () => {
    render(<DecomisoHandoffActions {...props} />);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Aceptar custodia" }));
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });
});
