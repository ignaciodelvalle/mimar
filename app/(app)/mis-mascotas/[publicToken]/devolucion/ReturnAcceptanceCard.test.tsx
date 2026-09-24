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
    fireEvent.click(screen.getByRole("button", { name: "Marcar como recibida" }));
    await waitFor(() => expect(acceptAction).toHaveBeenCalled());
    expect(acceptAction.mock.calls[0][0]).toBe("DIM-PAMP-0001");

    expect(
      await screen.findByRole("heading", { name: "Devolución confirmada" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pampa está de vuelta con vos. La custodia de Refugio Sur quedó cerrada y le avisamos que la recibiste.",
      ),
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
    fireEvent.click(screen.getByRole("button", { name: "Marcar como recibida" }));

    expect(await screen.findByText("La propuesta ya no es válida")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Devolución confirmada" })).toBeNull();
  });

  it("an error keeps the card and shows it", async () => {
    acceptAction.mockResolvedValue({ error: "No se pudo confirmar." });
    render(<ReturnAcceptanceCard {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como recibida" }));

    expect(await screen.findByText("No se pudo confirmar.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Devolución confirmada" })).toBeNull();
  });
});
