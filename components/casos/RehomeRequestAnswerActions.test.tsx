// @vitest-environment jsdom
//
// The sponsoring org's two answers to a titular's rehome_request, on the
// case detail (rehome-by-titular WU5, task 5.7; spec REQ-4, REQ-5).
//
// Accept is the one the org cannot take back — REQ-15 gives the titular the
// only exit — so it does not fire on one tap, and its confirmation says what
// the org is actually taking on: registry custody to publish and vet, over
// an animal that keeps living with its family.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const respondAction = vi.fn();
vi.mock("@/src/modules/rehome/actions", () => ({
  respondToRehomeRequestAction: (...args: unknown[]) => respondAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import { RehomeRequestAnswerActions } from "./RehomeRequestAnswerActions";

const BASE = {
  orgToken: "DIM-ORG-0001",
  casePublicCode: "CAS-ABCD-1234",
  petName: "Tango",
  orgDisplayName: "Refugio Padrino",
};

beforeEach(() => {
  respondAction.mockReset().mockResolvedValue({
    ok: true,
    decision: "accept",
    petPublicToken: "DIM-PET1",
    redirectTo: "/casos/CAS-ABCD-1234",
  });
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => cleanup());

describe("accepting", () => {
  it("offers both answers by what the org controls, and fires neither on the first tap", () => {
    render(<RehomeRequestAnswerActions {...BASE} />);
    expect(screen.getByRole("button", { name: "Aceptar el acompañamiento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar la solicitud" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el acompañamiento" }));
    expect(respondAction).not.toHaveBeenCalled();
  });

  it("says what accepting means before the org commits: custody to publish, the animal stays home, only the titular ends it", () => {
    render(<RehomeRequestAnswerActions {...BASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el acompañamiento" }));
    expect(screen.getByText(/sigue viviendo con su familia/)).toBeInTheDocument();
    expect(screen.getByText(/no lo tiene en su poder/)).toBeInTheDocument();
    expect(screen.getByText(/Solo el titular puede dar de baja/)).toBeInTheDocument();
  });

  it("accepts on confirmation with the URL org and the case, then reloads the detail", async () => {
    render(<RehomeRequestAnswerActions {...BASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el acompañamiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el acompañamiento" }));
    await waitFor(() =>
      expect(respondAction).toHaveBeenCalledWith({
        orgToken: "DIM-ORG-0001",
        casePublicCode: "CAS-ABCD-1234",
        decision: "accept",
      }),
    );
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith("/casos/CAS-ABCD-1234"),
    );
  });

  it("renders the use-case's refusal inline instead of reloading over it", async () => {
    respondAction.mockResolvedValue({
      error: "Esta mascota ya está bajo custodia de una organización.",
    });
    render(<RehomeRequestAnswerActions {...BASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar el acompañamiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el acompañamiento" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Esta mascota ya está bajo custodia de una organización.",
      ),
    );
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("declining", () => {
  it("declines with the decline decision, never the accept one", async () => {
    respondAction.mockResolvedValue({
      ok: true,
      decision: "decline",
      petPublicToken: "DIM-PET1",
      redirectTo: "/casos/CAS-ABCD-1234",
    });
    render(<RehomeRequestAnswerActions {...BASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar la solicitud" }));
    expect(screen.getByText(/puede pedírselo a otra organización/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el rechazo" }));
    await waitFor(() =>
      expect(respondAction).toHaveBeenCalledWith({
        orgToken: "DIM-ORG-0001",
        casePublicCode: "CAS-ABCD-1234",
        decision: "decline",
      }),
    );
  });

  it("'Volver' backs out of a confirmation without calling anything", () => {
    render(<RehomeRequestAnswerActions {...BASE} />);
    fireEvent.click(screen.getByRole("button", { name: "Rechazar la solicitud" }));
    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    expect(screen.getByRole("button", { name: "Aceptar el acompañamiento" })).toBeInTheDocument();
    expect(respondAction).not.toHaveBeenCalled();
  });
});
