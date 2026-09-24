// @vitest-environment jsdom
//
// The titular's surface for the adoption sponsorship (rehome-by-titular WU5,
// task 5.8 — carried from 4.3). ONE panel, THREE states, because they are the
// same question at different moments: "who is helping find this animal a
// home, and where does that stand?"
//
//   none    → the verified orgs covering the pet's zone, one ask each
//   pending → who was asked, and the lever to cancel before they answer
//   active  → who accompanies, what that means, and the lever to end it
//
// Cancel and withdraw are DIFFERENT FACTS (REQ-3 vs REQ-8): nothing started
// vs a running arrangement with a custody row and a listing. The component
// keeps them apart, and the end of a running one asks for a confirmation.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestAction = vi.fn();
const cancelAction = vi.fn();
const withdrawAction = vi.fn();
vi.mock("@/src/modules/rehome/actions", () => ({
  requestRehomeSponsorshipAction: (...args: unknown[]) => requestAction(...args),
  withdrawRehomeRequestAction: (...args: unknown[]) => cancelAction(...args),
  withdrawRehomeSponsorshipAction: (...args: unknown[]) => withdrawAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import { TitularRehomePanel } from "./TitularRehomePanel";

const PET = { petPublicToken: "DIM-TEST-0001", petName: "Tango" };

const ORGS = [
  { id: "org-a", displayName: "Refugio Padrino", orgType: "shelter", locality: "La Plata" },
  { id: "org-b", displayName: "Red Patitas", orgType: "rescue_network", locality: "Berisso" },
];

beforeEach(() => {
  requestAction.mockReset().mockResolvedValue({
    casePublicCode: "CAS-ABCD-1234",
    redirectTo: "/mis-mascotas/DIM-TEST-0001/buscar-hogar",
  });
  cancelAction.mockReset().mockResolvedValue({
    ok: true,
    redirectTo: "/mis-mascotas/DIM-TEST-0001/buscar-hogar",
  });
  withdrawAction.mockReset().mockResolvedValue({
    ok: true,
    redirectTo: "/mis-mascotas/DIM-TEST-0001/buscar-hogar",
  });
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => cleanup());

describe("state: none — the org picker", () => {
  it("lists each org by what the titular recognises: name, kind and locality, with one ask each", () => {
    render(<TitularRehomePanel {...PET} state={{ kind: "none", orgs: ORGS }} />);
    expect(screen.getByText("Refugio Padrino")).toBeInTheDocument();
    expect(screen.getByText(/Refugio · La Plata/)).toBeInTheDocument();
    expect(screen.getByText("Red Patitas")).toBeInTheDocument();
    expect(screen.getByText(/Red de rescate · Berisso/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Pedir acompañamiento/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Cancelar el pedido/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Dar de baja el acompañamiento/ }),
    ).not.toBeInTheDocument();
  });

  it("asks the chosen org and reloads to the page's pending state", async () => {
    render(<TitularRehomePanel {...PET} state={{ kind: "none", orgs: ORGS }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pedir acompañamiento a Red Patitas" }));
    await waitFor(() =>
      expect(requestAction).toHaveBeenCalledWith({
        petPublicToken: "DIM-TEST-0001",
        targetOrgId: "org-b",
      }),
    );
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(
        "/mis-mascotas/DIM-TEST-0001/buscar-hogar",
      ),
    );
  });

  it("renders the use-case's refusal inline, next to the org it refused", async () => {
    requestAction.mockResolvedValue({
      error: "Ya hay una solicitud de nuevo hogar pendiente para esta mascota.",
    });
    render(<TitularRehomePanel {...PET} state={{ kind: "none", orgs: ORGS }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pedir acompañamiento a Refugio Padrino" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Ya hay una solicitud de nuevo hogar pendiente para esta mascota.",
      ),
    );
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("state: pending — asked, not answered", () => {
  const PENDING = {
    kind: "pending" as const,
    orgDisplayName: "Refugio Padrino",
    casePublicCode: "CAS-ABCD-1234",
  };

  it("keeps the action's name through the flow and links to the request", () => {
    render(<TitularRehomePanel {...PET} state={PENDING} />);
    expect(screen.getByText(/Pedido enviado a Refugio Padrino/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver la solicitud/ })).toHaveAttribute(
      "href",
      "/casos/CAS-ABCD-1234",
    );
    expect(screen.queryByRole("button", { name: /Pedir acompañamiento/ })).not.toBeInTheDocument();
  });

  it("cancels the pending request — the cancel action, never the withdraw one", async () => {
    render(<TitularRehomePanel {...PET} state={PENDING} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar el pedido" }));
    expect(cancelAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar la cancelación" }));
    await waitFor(() =>
      expect(cancelAction).toHaveBeenCalledWith({ petPublicToken: "DIM-TEST-0001" }),
    );
    expect(withdrawAction).not.toHaveBeenCalled();
    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalled());
  });
});

describe("state: active — an org accompanies the adoption", () => {
  const ACTIVE = {
    kind: "active" as const,
    orgDisplayName: "Refugio Padrino",
    listingCasePublicCode: "CAS-LIST-0001",
  };

  it("says who accompanies and what it means: the animal stays home, the org publishes and vets", () => {
    render(<TitularRehomePanel {...PET} state={ACTIVE} />);
    expect(screen.getByText(/Refugio Padrino acompaña la adopción de Tango/)).toBeInTheDocument();
    expect(screen.getByText(/sigue viviendo con vos/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver el expediente/ })).toHaveAttribute(
      "href",
      "/casos/CAS-LIST-0001",
    );
  });

  it("does not end the sponsorship on the first tap, and the confirmation says what ends", () => {
    render(<TitularRehomePanel {...PET} state={ACTIVE} />);
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja el acompañamiento" }));
    expect(withdrawAction).not.toHaveBeenCalled();
    expect(screen.getByText(/se retira de la búsqueda de hogar/)).toBeInTheDocument();
    expect(screen.getByText(/postulaciones .*quedan cerradas/)).toBeInTheDocument();
  });

  it("withdraws on confirmation — the withdraw action, never the cancel one", async () => {
    render(<TitularRehomePanel {...PET} state={ACTIVE} />);
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja el acompañamiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar la baja" }));
    await waitFor(() =>
      expect(withdrawAction).toHaveBeenCalledWith({ petPublicToken: "DIM-TEST-0001" }),
    );
    expect(cancelAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(
        "/mis-mascotas/DIM-TEST-0001/buscar-hogar",
      ),
    );
  });

  it("surfaces a refusal instead of reloading over it", async () => {
    withdrawAction.mockResolvedValue({
      error: "Esta mascota no tiene un acompañamiento de adopción activo.",
    });
    render(<TitularRehomePanel {...PET} state={ACTIVE} />);
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja el acompañamiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar la baja" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Esta mascota no tiene un acompañamiento de adopción activo.",
      ),
    );
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("quality floor", () => {
  it("uses the house button for every control — no raw <button>", () => {
    const { container } = render(
      <TitularRehomePanel
        {...PET}
        state={{ kind: "active", orgDisplayName: "Refugio Padrino", listingCasePublicCode: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja el acompañamiento" }));
    // LnButton renders `rounded-[var(--radius-pill)]`; a hand-rolled button would
    // not. Asserting the token, not a colour class, is the repo's own fence
    // (scripts/check-raw-buttons.mjs) stated at the component level.
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className).toContain("rounded-[var(--radius-pill)]");
  });
});
