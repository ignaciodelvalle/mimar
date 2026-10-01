// @vitest-environment jsdom
//
// RequestCapabilityForm — a saved request reloads the dashboard (contract N3).
//
// The form used to wait on requestCapabilityAction's revalidation of the org
// dashboard, and in a production build that re-render never commits: the
// request was saved and the button read "Enviando…" forever (measured
// 2026-10-01). jsdom cannot see that defect — there is no RSC refresh here to
// hang; e2e/org-forms-settle.spec.ts drives it against a real build. What this
// pins is the client half: the navigation fires from the action's own answer,
// and the button stays busy while the new document loads.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  requestCapabilityAction: (...args: unknown[]) => actionMock(...args),
}));

const navigateSpy = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateSpy(url),
}));

import { RequestCapabilityForm } from "./RequestCapabilityForm";

beforeEach(() => {
  actionMock.mockReset();
  navigateSpy.mockReset();
});

afterEach(cleanup);

function openAndSubmit(): void {
  const { container } = render(
    <RequestCapabilityForm
      capability="custody.transfer"
      label="Transferir custodia"
      orgToken="ORG-TEST-0001"
    />,
  );
  fireEvent.click(screen.getByText("Solicitar"));
  (container.querySelector("form") as HTMLFormElement).requestSubmit();
}

describe("<RequestCapabilityForm> — a saved request reloads the dashboard", () => {
  it("navigates to the destination the action answered, once", async () => {
    actionMock.mockResolvedValue({ error: null, ok: true, redirectTo: "/org/ORG-TEST-0001" });
    openAndSubmit();

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/org/ORG-TEST-0001"));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the button busy after the action has settled — the page is on its way out", async () => {
    actionMock.mockResolvedValue({ error: null, ok: true, redirectTo: "/org/ORG-TEST-0001" });
    openAndSubmit();

    // The success line renders from the SETTLED state, so by now the action's
    // own pending flag is down; only the navigation keeps the button disabled.
    await screen.findByText("Solicitud enviada. Te avisamos cuando alguien decida.");
    const submit = screen.getByRole("button", { name: "Enviando…" });
    expect(submit).toBeDisabled();
  });

  it("a refused request does not navigate and gives the button back", async () => {
    actionMock.mockResolvedValue({
      error: "Ya tenés una solicitud pendiente o un permiso concedido para esto.",
    });
    openAndSubmit();

    await screen.findByText("Ya tenés una solicitud pendiente o un permiso concedido para esto.");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar pedido" })).toBeEnabled();
  });
});
