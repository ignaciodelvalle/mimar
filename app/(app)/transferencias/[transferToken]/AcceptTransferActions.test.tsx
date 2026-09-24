// @vitest-environment jsdom
//
// Accepting a pet transfer ends on a receipt (L-13), not on a mute navigation.
//
// The receipt lives in this island, and the page renders the island
// unconditionally so the action's RSC refresh (the transfer is 'accepted' by
// then) cannot unmount it under its own receipt. jsdom cannot run that refresh,
// so the closest faithful stand-in is a RE-RENDER with the post-accept props
// (`isPending: false`) — the same element type in the same slot, which is what
// the page now guarantees. A version of the component that gated itself on
// `isPending` before looking at its local success would fail that step.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const acceptPetTransferAction = vi.fn();
vi.mock("@/src/modules/transfers/actions", () => ({
  acceptPetTransferAction: (...args: unknown[]) => acceptPetTransferAction(...args),
  cancelPetTransferAction: vi.fn(),
  rejectPetTransferAction: vi.fn(),
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

import { AcceptTransferActions } from "./AcceptTransferActions";

const PROPS = {
  transferToken: "TRF-ABC",
  isPending: true,
  isRecipient: true,
  isSender: false,
  petToken: "DIM-PAMP-0001",
  petName: "Pampa",
};

beforeEach(() => {
  acceptPetTransferAction.mockReset().mockResolvedValue({ ok: true });
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => cleanup());

async function acceptThroughDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
  fireEvent.click(screen.getByRole("button", { name: "Aceptar transferencia" }));
  await waitFor(() => expect(acceptPetTransferAction).toHaveBeenCalledWith("TRF-ABC"));
}

describe("accepting a transfer ends on its receipt", () => {
  it("renders the success screen naming the new titular and the pet", async () => {
    render(<AcceptTransferActions {...PROPS} />);
    await acceptThroughDialog();

    expect(
      await screen.findByRole("heading", { name: "Transferencia aceptada" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ahora sos titular de Pampa\./)).toBeInTheDocument();
  });

  it("keeps the old redirect target only as the receipt's first action", async () => {
    render(<AcceptTransferActions {...PROPS} />);
    await acceptThroughDialog();

    const libreta = await screen.findByRole("link", { name: "Ver la libreta de Pampa" });
    expect(libreta).toHaveAttribute("href", "/mis-mascotas/DIM-PAMP-0001");
    expect(screen.getByRole("link", { name: "Ir a mis mascotas" })).toHaveAttribute(
      "href",
      "/mis-mascotas",
    );
    // No navigation by hand: the person reads the receipt first.
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });

  it("the receipt survives the post-accept re-render (isPending false)", async () => {
    const { rerender } = render(<AcceptTransferActions {...PROPS} />);
    await acceptThroughDialog();
    await screen.findByRole("heading", { name: "Transferencia aceptada" });

    rerender(<AcceptTransferActions {...PROPS} isPending={false} />);
    expect(screen.getByRole("heading", { name: "Transferencia aceptada" })).toBeInTheDocument();
  });

  it("a failed accept shows the error and no receipt", async () => {
    acceptPetTransferAction.mockResolvedValue({ error: "La transferencia ya no está pendiente." });
    render(<AcceptTransferActions {...PROPS} />);
    await acceptThroughDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La transferencia ya no está pendiente.",
    );
    expect(screen.queryByRole("heading", { name: "Transferencia aceptada" })).toBeNull();
  });
});

describe("a transfer that is no longer pending", () => {
  it("renders nothing when it was not accepted here", () => {
    const { container } = render(<AcceptTransferActions {...PROPS} isPending={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
