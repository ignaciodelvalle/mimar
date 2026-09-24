// @vitest-environment jsdom
//
// Deciding an adoption application ends on a receipt (L-13), no longer on a
// router.push back to the queue.
//
// approve/reject revalidate THIS route, so the action's RSC refresh re-renders
// the page with the decision on file. The page now always renders ReviewButtons
// in the same slot and passes the server's resolved view in as `resolvedView`;
// the re-render step below stands in for that refresh (jsdom cannot run it).
// A component that let `resolvedView` win over its own local decision would
// swap the receipt for the summary — the test fails on that.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const approveAction = vi.fn();
const rejectAction = vi.fn();
vi.mock("@/src/modules/adoption/actions", () => ({
  approveAdoptionApplicationAction: (...args: unknown[]) => approveAction(...args),
  rejectAdoptionApplicationAction: (...args: unknown[]) => rejectAction(...args),
  requestInfoAdoptionApplicationAction: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReviewButtons } from "./ReviewButtons";

const PROPS = {
  orgToken: "ORG-1",
  applicationEventId: "11111111-1111-1111-1111-111111111111",
  applicantName: "Ana Pérez",
  petName: "Pampa",
  finalizeHref: "/org/ORG-1/mascotas/DIM-PAMP-0001/adoption",
  resolvedView: null,
};

beforeEach(() => {
  approveAction.mockReset().mockResolvedValue({ ok: true });
  rejectAction.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("approving ends on the receipt", () => {
  it("names the applicant, the pet and the next step, with finalize as the first action", async () => {
    render(<ReviewButtons {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aprobar postulación" }));
    fireEvent.click(screen.getByRole("button", { name: "Aprobar postulación" }));
    await waitFor(() => expect(approveAction).toHaveBeenCalled());

    expect(
      await screen.findByRole("heading", { name: "Postulación aprobada" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ana Pérez recibe una notificación y un mail. La adopción de Pampa se concreta cuando la finalices en su ficha.",
      ),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("Finalizar la adopción");
    expect(links[0]).toHaveAttribute("href", "/org/ORG-1/mascotas/DIM-PAMP-0001/adoption");
    expect(screen.getByRole("link", { name: "Volver a las postulaciones" })).toHaveAttribute(
      "href",
      "/org/ORG-1/adopciones",
    );
  });

  it("the receipt survives the refresh that brings the resolved view", async () => {
    const { rerender } = render(<ReviewButtons {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Aprobar postulación" }));
    fireEvent.click(screen.getByRole("button", { name: "Aprobar postulación" }));
    await screen.findByRole("heading", { name: "Postulación aprobada" });

    rerender(<ReviewButtons {...PROPS} resolvedView={<p>Resumen del servidor</p>} />);
    expect(screen.getByRole("heading", { name: "Postulación aprobada" })).toBeInTheDocument();
    expect(screen.queryByText("Resumen del servidor")).toBeNull();
  });
});

describe("not advancing ends on the receipt", () => {
  it("says the application is closed and the applicant is told", async () => {
    render(<ReviewButtons {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "No avanzar" }));
    fireEvent.click(screen.getByRole("button", { name: "No avanzar" }));
    await waitFor(() => expect(rejectAction).toHaveBeenCalled());

    expect(await screen.findByRole("heading", { name: "Postulación cerrada" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "No avanzaste con la postulación de Ana Pérez. Le llega una notificación con la decisión.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Finalizar la adopción" })).toBeNull();
  });
});

describe("an application already decided elsewhere", () => {
  it("shows the server's resolved view and no controls", () => {
    render(<ReviewButtons {...PROPS} resolvedView={<p>Resumen del servidor</p>} />);
    expect(screen.getByText("Resumen del servidor")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar postulación" })).toBeNull();
  });
});
