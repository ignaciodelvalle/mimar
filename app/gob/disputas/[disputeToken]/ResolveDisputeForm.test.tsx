// @vitest-environment jsdom
//
// ResolveDisputeForm — the modal gate added by D.3 clase 1 (2026-07-30).
//
// This is the gravest single click a government official makes in the system:
// resolving a custody dispute with outcome `ownership_transferred` closes EVERY
// active ownership on the pet and opens a new one at the destination. Until
// this change it fired straight off the "Resolver disputa" button, with the
// consequence stated only as a grey hint paragraph next to the destination
// field — which the official may never have scrolled past.
//
// The load-bearing assertion is the FIRST CLICK: with a fully valid form, it
// must open a dialog and NOT call resolveDisputeAction.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveDisputeAction = vi.fn();
const lookupTransferTargetAction = vi.fn();
vi.mock("@/app/actions/custody-disputes", () => ({
  resolveDisputeAction: (...args: unknown[]) => resolveDisputeAction(...args),
  lookupTransferTargetAction: (...args: unknown[]) => lookupTransferTargetAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

import { ResolveDisputeForm } from "./ResolveDisputeForm";

// The action refuses summaries under 100 chars, so every test that expects to
// reach the dialog has to clear that bar first.
const VALID_SUMMARY =
  "Se analizó la prueba documental aportada por ambas partes, se contrastó con el registro de eventos " +
  "de la mascota y se resolvió en favor de la parte con titularidad acreditada.";

function fillSummary() {
  fireEvent.change(screen.getByLabelText(/Resumen de la resolución/), {
    target: { value: VALID_SUMMARY },
  });
}

beforeEach(() => {
  resolveDisputeAction.mockReset();
  lookupTransferTargetAction.mockReset();
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ResolveDisputeForm — the resolve act is gated behind a modal", () => {
  it("the first click on a VALID form opens a ConfirmDialog and does NOT resolve", () => {
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    fillSummary();

    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));

    expect(resolveDisputeAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Resolver la disputa de custodia" }),
    ).toBeInTheDocument();
  });

  it("confirming through the dialog calls resolveDisputeAction exactly once", async () => {
    resolveDisputeAction.mockResolvedValue({ ok: true });
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    fillSummary();

    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));
    const dialog = screen.getByRole("dialog", { name: "Resolver la disputa de custodia" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolver disputa" }));

    await waitFor(() => {
      expect(resolveDisputeAction).toHaveBeenCalledTimes(1);
    });
    expect(resolveDisputeAction).toHaveBeenCalledWith(
      expect.objectContaining({ disputeToken: "dt-1", resolution: "ownership_confirmed" }),
    );
  });

  it("cancelling the dialog does not resolve", () => {
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    fillSummary();

    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));
    const dialog = screen.getByRole("dialog", { name: "Resolver la disputa de custodia" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(resolveDisputeAction).not.toHaveBeenCalled();
  });

  it("an INVALID form never reaches the dialog (validation still runs first)", () => {
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    // No summary typed — under the 100-char floor.
    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(resolveDisputeAction).not.toHaveBeenCalled();
    expect(screen.getByText("El resumen tiene que tener al menos 100 caracteres.")).toBeVisible();
  });
});

describe("ResolveDisputeForm — the dialog states the consequence per outcome", () => {
  it("ownership_transferred reuses the SAME sentence as the inline hint (no drift)", async () => {
    lookupTransferTargetAction.mockResolvedValue({
      found: true,
      displayName: "Refugio Norte",
      active: true,
    });
    render(<ResolveDisputeForm disputeToken="dt-1" />);

    fireEvent.change(screen.getByLabelText("Resolución"), {
      target: { value: "ownership_transferred" },
    });
    fireEvent.change(screen.getByLabelText(/ID de usuario destino/), {
      target: { value: "11111111-1111-1111-1111-111111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => {
      expect(screen.getByText("Refugio Norte")).toBeInTheDocument();
    });
    fillSummary();

    // The hint under the destination field.
    const hint =
      "La transferencia cierra todas las ownerships activas y abre una nueva al destino.";
    expect(screen.getByText(hint)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));
    const dialog = screen.getByRole("dialog", { name: "Resolver la disputa de custodia" });
    // …and the same sentence, verbatim, inside the dialog. Both render from one
    // constant, so this pins that they cannot drift apart.
    expect(within(dialog).getByText(new RegExp(hint.replace(/\./g, "\\.")))).toBeInTheDocument();
  });

  it("ownership_confirmed states its own (non-transfer) consequence", () => {
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    fillSummary();

    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));
    const dialog = screen.getByRole("dialog", { name: "Resolver la disputa de custodia" });
    expect(
      within(dialog).getByText(
        /Esto confirma al dueño actual y cierra la disputa.*evento inmutable.*no se puede deshacer/,
      ),
    ).toBeInTheDocument();
  });
});

describe("ResolveDisputeForm — grammar of confirmation (D.3)", () => {
  it('the confirm button carries the verb of the act, not "Confirmar"', () => {
    render(<ResolveDisputeForm disputeToken="dt-1" />);
    fillSummary();
    fireEvent.click(screen.getByRole("button", { name: "Resolver disputa" }));

    const dialog = screen.getByRole("dialog", { name: "Resolver la disputa de custodia" });
    expect(within(dialog).queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Resolver disputa" })).toBeInTheDocument();
  });
});
