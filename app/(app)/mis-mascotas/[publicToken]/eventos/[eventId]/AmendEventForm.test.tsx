// @vitest-environment jsdom
//
// AmendEventForm — the two doors (portal-vet-p0 D8). The owner's event page
// posts to `amendEventAction` and reloads in place, with an optional reason;
// Atender passes its own org-scoped action, requires the reason (≥5
// characters, what the owner reads) and goes where the action says — its
// `?corregido=1` receipt.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const amendEventAction = vi.fn();
vi.mock("@/app/actions/amendment", () => ({
  amendEventAction: (...args: unknown[]) => amendEventAction(...args),
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

import { AmendEventForm } from "./AmendEventForm";

const BASE = {
  eventId: "evt-1",
  eventType: "vaccination_administered",
  currentPayload: { vaccine_name: "Antirrábica", batch: "L-1" },
  publicToken: "DIM-TEST-0001",
  onClose: vi.fn(),
};

function editBatch(value: string) {
  fireEvent.change(screen.getByLabelText("Nuevo valor para Batch"), { target: { value } });
}

function typeReason(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/Describí brevemente/), { target: { value } });
}

function submitAndConfirm() {
  const form = screen.getByRole("dialog", { name: "Corregir registro" });
  fireEvent.click(within(form).getByRole("button", { name: "Confirmar corrección" }));
  const confirm = screen.getByRole("dialog", { name: "Confirmar corrección" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirmar corrección" }));
}

beforeEach(() => {
  amendEventAction.mockReset();
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AmendEventForm — the Atender door", () => {
  it("refuses to submit without a reason of at least 5 characters, and says so", () => {
    const submitAction = vi.fn();
    render(<AmendEventForm {...BASE} submitAction={submitAction} reasonRequired />);
    editBatch("L-9");
    typeReason("abc");

    const form = screen.getByRole("dialog", { name: "Corregir registro" });
    fireEvent.click(within(form).getByRole("button", { name: "Confirmar corrección" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Contá el motivo de la corrección (mínimo 5 caracteres).",
    );
    expect(screen.queryByRole("dialog", { name: "Confirmar corrección" })).toBeNull();
    expect(submitAction).not.toHaveBeenCalled();
  });

  it("marks the reason mandatory in its hint", () => {
    render(<AmendEventForm {...BASE} submitAction={vi.fn()} reasonRequired />);
    expect(
      screen.getByText("Obligatorio, mínimo 5 caracteres. Es lo que lee el dueño."),
    ).toBeInTheDocument();
  });

  it("posts to ITS action — never the owner door — and goes to the receipt it returns", async () => {
    const submitAction = vi.fn().mockResolvedValue({
      ok: true,
      error: null,
      redirectTo: "/org/ORG/atender/DIM-TEST-0001?corregido=1",
    });
    render(<AmendEventForm {...BASE} submitAction={submitAction} reasonRequired />);
    editBatch("L-9");
    typeReason("Lote mal transcripto");
    submitAndConfirm();

    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(submitAction).toHaveBeenCalledWith({
      publicToken: "DIM-TEST-0001",
      targetEventId: "evt-1",
      reason: "Lote mal transcripto",
      changes: [{ field: "batch", old: "L-1", new: "L-9" }],
    });
    expect(amendEventAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(
        "/org/ORG/atender/DIM-TEST-0001?corregido=1",
      ),
    );
  });

  it("shows the server's refusal and stays put", async () => {
    const submitAction = vi.fn().mockResolvedValue({
      ok: false,
      error: "Desde Atender solo se corrigen registros que cargó esta organización.",
    });
    render(<AmendEventForm {...BASE} submitAction={submitAction} reasonRequired />);
    editBatch("L-9");
    typeReason("Lote mal transcripto");
    submitAndConfirm();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Desde Atender solo se corrigen registros que cargó esta organización.",
      ),
    );
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("AmendEventForm — the owner door is unchanged", () => {
  it("posts to amendEventAction with an optional reason and reloads in place", async () => {
    amendEventAction.mockResolvedValue({ ok: true, amendmentEventId: "a-1", wasDuplicate: false });
    render(<AmendEventForm {...BASE} />);
    editBatch("L-9");
    submitAndConfirm();

    await waitFor(() => expect(amendEventAction).toHaveBeenCalledTimes(1));
    expect(amendEventAction).toHaveBeenCalledWith({
      publicToken: "DIM-TEST-0001",
      targetEventId: "evt-1",
      reason: null,
      changes: [{ field: "batch", old: "L-1", new: "L-9" }],
    });
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(window.location.href),
    );
    expect(screen.getByText("Obligatorio para administradores y gobierno")).toBeInTheDocument();
  });
});
