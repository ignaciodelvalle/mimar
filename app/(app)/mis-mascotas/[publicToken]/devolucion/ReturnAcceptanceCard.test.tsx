// @vitest-environment jsdom
//
// Confirming a return ends on LnSuccessScreen (L-13) — devolución is one of the
// trámites AGENTS.md names as closing on a receipt. Drives the REAL
// useActionState through the form; only the server action is mocked.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acceptAction = vi.fn();
vi.mock("@/app/actions/return-to-owner-form", () => ({
  ownerAcceptReturnFormAction: (...args: unknown[]) => acceptAction(...args),
  ownerRejectReturnFormAction: vi.fn(),
}));

import { ReturnAcceptanceCard } from "./ReturnAcceptanceCard";
import { acceptedSentence, confirmSentence, rejectSentence, returnHeadline } from "./return-copy";

const PROPS = {
  petPublicToken: "DIM-PAMP-0001",
  petName: "Pampa",
  actorName: "Refugio Sur",
  proposalNotes: null,
  proposedAt: "2026-09-10T12:00:00.000Z",
  backUrl: "/mis-mascotas",
};

beforeEach(() => {
  acceptAction.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => cleanup());

describe("confirming the return", () => {
  it("renders the receipt: what happened, who was told, and where to go", async () => {
    render(<ReturnAcceptanceCard {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ya tengo a Pampa" }));
    await waitFor(() => expect(acceptAction).toHaveBeenCalled());
    expect(acceptAction.mock.calls[0][0]).toBe("DIM-PAMP-0001");

    expect(
      await screen.findByRole("heading", { name: "Devolución confirmada" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("¡Listo! Pampa ya está en casa con vos. Le avisamos a Refugio Sur."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver la libreta de Pampa" })).toHaveAttribute(
      "href",
      "/mis-mascotas/DIM-PAMP-0001",
    );
    expect(screen.getByRole("link", { name: "Ir a mis mascotas" })).toHaveAttribute(
      "href",
      "/mis-mascotas",
    );
  });

  it("an auto-cancelled proposal shows its explanation, never the receipt", async () => {
    acceptAction.mockResolvedValue({
      error: null,
      autoCancelled: true,
      autoCancelReason: "La mascota ya no está bajo esa custodia.",
    });
    render(<ReturnAcceptanceCard {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ya tengo a Pampa" }));

    expect(await screen.findByText("La propuesta ya no es válida")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Devolución confirmada" })).toBeNull();
  });

  it("an error keeps the card and shows it", async () => {
    acceptAction.mockResolvedValue({ error: "No se pudo confirmar." });
    render(<ReturnAcceptanceCard {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ya tengo a Pampa" }));

    expect(await screen.findByText("No se pudo confirmar.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Devolución confirmada" })).toBeNull();
  });
});

describe("the sentences by who proposed", () => {
  it("a shelter's proposal reads as the pet being safe and waiting", () => {
    render(<ReturnAcceptanceCard {...PROPS} actorKind="organization" />);
    expect(
      screen.getByText(
        "Tocá el botón cuando ya tengas a Pampa con vos. Ahí el refugio deja de cuidarla.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Rechazar la devolución"));
    expect(
      screen.getByText("Si no es tu mascota o algo no está bien, contale el motivo al refugio."),
    ).toBeInTheDocument();
  });

  it("a person's proposal reads as the end of a temporary care", () => {
    render(<ReturnAcceptanceCard {...PROPS} actorKind="person" />);
    expect(
      screen.getByText(
        "Tocá el botón cuando ya tengas a Pampa con vos. Ahí termina su cuidado temporal.",
      ),
    ).toBeInTheDocument();
  });
});

describe("web and mobile say the same thing", () => {
  it.each(["organization", "person"] as const)("%s proposer", async (kind) => {
    const mobile = await import("../../../../../apps/mobile/src/custody/devolucion-view-model");
    const state = { kind: "inbound_pending", actorName: "Refugio Sur", actorKind: kind } as never;
    expect(returnHeadline(kind, "Refugio Sur", "Pampa")).toBe(
      mobile.returnStateHeadline(state, "Pampa"),
    );
    expect(confirmSentence(kind, "Pampa")).toBe(mobile.confirmReturnSentence(state, "Pampa"));
    expect(rejectSentence(kind)).toBe(mobile.rejectReturnSentence(state));
    expect(acceptedSentence("Pampa")).toBe(
      mobile.acceptedMessage({ autoCancelled: false, reason: null }, "Pampa").message,
    );
  });
});
