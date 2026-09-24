// @vitest-environment jsdom
//
// IncomingTransferActions — ConfirmDialog symmetry fix (audit-3-feedback
// §C2 asymmetry #3, 2026-07-21): accept and reject previously shared an
// inline mode-switch panel with no ConfirmDialog and no stated consequence.
// Both now use ConfirmDialog with consequence copy, and success fires the
// shared notifySaved toast (mutation-feedback convention, §C1) since this
// component never reloads.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const acceptCrossOrgTransferAction = vi.fn();
const rejectCrossOrgTransferAction = vi.fn();
vi.mock("@/src/modules/transfers/actions", () => ({
  acceptCrossOrgTransferAction: (...args: unknown[]) => acceptCrossOrgTransferAction(...args),
  rejectCrossOrgTransferAction: (...args: unknown[]) => rejectCrossOrgTransferAction(...args),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

// jsdom doesn't implement native <dialog>.showModal/close — stubbed the
// same way SharesManager.test.tsx does.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

import { IncomingTransferActions } from "./IncomingTransferActions";

const props = {
  receiverOrgToken: "org-1",
  casePublicCode: "DC-0001",
  petName: "Firulais",
  permanentOwnership: false,
};

beforeEach(() => {
  acceptCrossOrgTransferAction.mockReset();
  rejectCrossOrgTransferAction.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("IncomingTransferActions — accept", () => {
  it("opens a ConfirmDialog naming the consequence, and confirms through it", async () => {
    acceptCrossOrgTransferAction.mockResolvedValue({ ok: true });
    render(<IncomingTransferActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    const dialog = screen.getByRole("dialog", {
      name: "Aceptar transferencia entre organizaciones",
    });
    expect(within(dialog).getByText(/Esto transfiere la custodia de Firulais/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Aceptar transferencia" }));

    await waitFor(() => {
      expect(acceptCrossOrgTransferAction).toHaveBeenCalledWith({
        receiverOrgToken: "org-1",
        casePublicCode: "DC-0001",
      });
    });
    expect(screen.getByText("Transferencia aceptada.")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Transferencia aceptada");
  });

  it("cancelling the dialog does not call the action", () => {
    render(<IncomingTransferActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    const dialog = screen.getByRole("dialog", {
      name: "Aceptar transferencia entre organizaciones",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(acceptCrossOrgTransferAction).not.toHaveBeenCalled();
  });

  it("shows the server error and does not toast when accept fails", async () => {
    acceptCrossOrgTransferAction.mockResolvedValue({ error: "El caso ya fue procesado." });
    render(<IncomingTransferActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    const dialog = screen.getByRole("dialog", {
      name: "Aceptar transferencia entre organizaciones",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Aceptar transferencia" }));

    await waitFor(() => {
      expect(screen.getByText("El caso ya fue procesado.")).toBeInTheDocument();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("IncomingTransferActions — reject (same ConfirmDialog mechanism as accept)", () => {
  it("carries the optional reason/message fields inside the dialog and submits them", async () => {
    rejectCrossOrgTransferAction.mockResolvedValue({ ok: true });
    render(<IncomingTransferActions {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    const dialog = screen.getByRole("dialog", {
      name: "Rechazar transferencia entre organizaciones",
    });
    fireEvent.change(within(dialog).getByPlaceholderText("Motivo del rechazo (opcional)"), {
      target: { value: "Duplicado" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Rechazar transferencia" }));

    await waitFor(() => {
      expect(rejectCrossOrgTransferAction).toHaveBeenCalledWith({
        receiverOrgToken: "org-1",
        casePublicCode: "DC-0001",
        reason: "Duplicado",
        message: null,
      });
    });
    expect(screen.getByText("Transferencia rechazada.")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Transferencia rechazada");
  });
});

// ---------------------------------------------------------------------------
// The receiving org must be told WHAT it is accepting.
//
// WHY (closing report L1 / fix queue row 18, 2026-08-22): a cross-org transfer
// proposal carries `to_role`, and it can be `owner` — accepting makes THIS
// organisation the pet's permanent legal owner, not a temporary custodian. The
// SENDER's form distinguishes the two, and so does the notification the receiver
// gets ("custodia temporal" vs "dueño permanente", transfer-custody.ts:205). The
// INBOX did not: it never read the field, and this dialog said "Esto transfiere
// la custodia de X a tu organización" for both.
//
// WHAT WAS REFUTED, and why this is copy only. The finding proposed gating
// `owner_by_org` behind an org-type allowlist. The skeptics dropped it to LOW
// and the gate to unimplementable:
//   - `owner_by_org` is a value of the IMMUTABLE event schema, commented as
//     "the org keeps the animal permanently (sanctuary, institutional adoption,
//     seizure without rehoming)", exposed by two product flows with their own
//     buttons, and pinned as intentional by two tests.
//   - the transfer path grants NO new capability: one org acting alone can
//     register any animal in its own name at intake — no transfer, no second
//     org, no consent step. Gating only the transfer leaves the shorter door
//     open.
//   - the org-type enum has no "sanctuary" value, so an allowlist cannot tell
//     the legitimate case from the illegitimate one. It cannot be built.
// So: no allowlist and no DB constraint — those need a PO decision. The real
// defect, which the finding walked past, is that the receiver never learns what
// it is agreeing to.
// ---------------------------------------------------------------------------

describe("IncomingTransferActions — destination role disclosure", () => {
  it("temporary custody keeps the custody wording and never claims ownership", () => {
    render(<IncomingTransferActions {...props} permanentOwnership={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toMatch(/custodia/i);
    expect(text).toMatch(/Firulais/);
    expect(text).not.toMatch(/dueñ/i);
  });

  it("permanent ownership says so, in the vocabulary the other two surfaces use", () => {
    render(<IncomingTransferActions {...props} permanentOwnership={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toMatch(/dueño permanente|titularidad/i);
    expect(text).toMatch(/Firulais/);
    // The consequence, not only the label.
    expect(text).toMatch(/responsable legal/i);
    expect(text).toMatch(/no se puede deshacer/i);
    // And it must not describe itself as the thing it is not.
    expect(text).toMatch(/no es una custodia temporal/i);
  });

  it("THE DEFECT: the two confirmations are no longer the same string", () => {
    const { unmount } = render(<IncomingTransferActions {...props} permanentOwnership={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    const custody = screen.getByRole("dialog").textContent ?? "";
    unmount();

    render(<IncomingTransferActions {...props} permanentOwnership={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    const ownership = screen.getByRole("dialog").textContent ?? "";

    // Non-vacuity: both dialogs really rendered something.
    expect(custody.length).toBeGreaterThan(20);
    expect(ownership.length).toBeGreaterThan(20);
    expect(ownership).not.toBe(custody);
  });

  it("the reject confirmation does NOT change with the role — rejecting is rejecting", () => {
    const { unmount } = render(<IncomingTransferActions {...props} permanentOwnership={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    const custody = screen.getByRole("dialog").textContent ?? "";
    unmount();

    render(<IncomingTransferActions {...props} permanentOwnership={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    expect(screen.getByRole("dialog").textContent ?? "").toBe(custody);
  });
});
