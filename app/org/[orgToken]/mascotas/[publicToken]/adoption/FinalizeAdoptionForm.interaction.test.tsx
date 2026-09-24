// @vitest-environment jsdom
//
// Interaction test for the finalize-adoption router-drop cure (QA ALTO,
// 2026-07-16). Exercises the REAL useActionState + useActionRedirect chain via
// RTL + jsdom: submit the form, let the mocked server action resolve, and
// assert the resulting state (a) drives a FULL document navigation via
// lib/ui/full-page-action-nav.ts's navigateAfterActionSuccess (immune to the
// Next 15.5.x router-drop), and (b) lands on the org custody LIST, never the
// transferred pet's now-404 ficha.
//
// Pattern mirrors NumericWindowRuleForm.interaction.test.tsx.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
const checkAccountMock = vi.fn();
vi.mock("@/src/modules/adoption/actions", () => ({
  finalizeAdoptionAction: Object.assign((...args: unknown[]) => actionMock(...args), {
    bind:
      (_thisArg: unknown, orgToken: string, publicToken: string) =>
      (...args: unknown[]) =>
        actionMock(orgToken, publicToken, ...args),
  }),
  checkAdopterAccountAction: (...args: unknown[]) => checkAccountMock(...args),
}));

const navigateMock = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateMock(url),
}));

import { FinalizeAdoptionForm } from "./FinalizeAdoptionForm";

const SIGNUP_QR_SVG = '<svg role="img" aria-label="signup-qr"><title>signup-qr</title></svg>';

const BASE_PROPS = {
  orgToken: "org-tok",
  publicToken: "DIM-1234-5678",
  fosterShortcut: null,
  // One approved application → the form defaults to the application path (no
  // required DNI field), so a bare programmatic submit reaches the action.
  approvedApplications: [{ applicationEventId: "app-1", applicantName: "Juana" }],
  signupQrSvg: SIGNUP_QR_SVG,
};

// No approved applications and no foster → the manual-DNI path renders
// directly (org-pilot-pack registered-adopter flow).
const MANUAL_DNI_PROPS = {
  ...BASE_PROPS,
  approvedApplications: [],
};

beforeEach(() => {
  actionMock.mockReset();
  checkAccountMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<FinalizeAdoptionForm> — post-success navigation (QA ALTO 2026-07-16)", () => {
  it("navigates to the org custody LIST (not the transferred pet's ficha) on success", async () => {
    actionMock.mockResolvedValue({
      error: null,
      redirectTo: "/org/org-tok/mascotas?adopcion=DIM-1234-5678",
    });

    render(<FinalizeAdoptionForm {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: "Finalizar adopción" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/org/org-tok/mascotas?adopcion=DIM-1234-5678");
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    // Destination is the LIST, never the pet's ficha (which now 404s).
    expect(navigateMock.mock.calls[0][0]).not.toContain("/mascotas/DIM-1234-5678");
  });

  it("resolves the pending state and does NOT navigate when the action errors", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo finalizar la adopción." });

    render(<FinalizeAdoptionForm {...BASE_PROPS} />);

    const button = screen.getByRole("button", { name: "Finalizar adopción" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("No se pudo finalizar la adopción.")).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
    // The button left the "Finalizando adopción…" pending label — it is no
    // longer stuck disabled forever (the QA symptom).
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeEnabled();
  });
});

describe("<FinalizeAdoptionForm> — registered-adopter DNI check (org-pilot-pack)", () => {
  it("found: shows the account panel and enables the finalize submit", async () => {
    checkAccountMock.mockResolvedValue({ found: true, displayName: "Juana Pérez" });

    render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    // The manual-DNI path is gated until the check succeeds.
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));

    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });
    expect(checkAccountMock).toHaveBeenCalledWith("org-tok", "30111222");
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeEnabled();
  });

  it("not found: renders the refusal panel with the signup QR and NO stub-creation promise", async () => {
    checkAccountMock.mockResolvedValue({ found: false });

    const { container } = render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Signup QR is rendered inside the refusal panel.
    expect(container.innerHTML).toContain("signup-qr");
    // The old false promise is gone from EVERY surface of this flow (spec 2.6).
    expect(container.innerHTML).not.toContain("perfil preliminar");
    expect(container.innerHTML).not.toContain("reclamar más adelante");
    // Refusal copy demands registering with the SAME DNI.
    expect(screen.getByText(/ese mismo DNI/)).toBeInTheDocument();
    // Finalize stays blocked.
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeDisabled();
  });

  it("re-verify after refusal re-checks WITHOUT losing context (no navigation, spec 2.5)", async () => {
    checkAccountMock.mockResolvedValueOnce({ found: false });

    render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // The adopter registered mid-flow on their own device; the org re-checks.
    checkAccountMock.mockResolvedValueOnce({ found: true, displayName: "Juana Pérez" });
    // findBy, not getBy: the refusal alert can commit while the check
    // transition is still pending, and for that tick the button reads
    // "Verificando…" (CI run 32555456201 caught it; locally the two commits
    // coincide). The name we want is the settled one.
    fireEvent.click(await screen.findByRole("button", { name: "Volver a verificar" }));

    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });
    // Same typed DNI, same in-progress form — and no navigation happened.
    expect(checkAccountMock).toHaveBeenLastCalledWith("org-tok", "30111222");
    expect(screen.getByLabelText(/DNI/)).toHaveValue("30111222");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("editing the DNI resets a previous 'found' so it cannot authorize another number", async () => {
    checkAccountMock.mockResolvedValue({ found: true, displayName: "Juana Pérez" });

    render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));
    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "40999888" } });

    expect(screen.queryByText("Cuenta encontrada: Juana Pérez")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeDisabled();
  });

  it("an IN-FLIGHT check whose DNI was edited mid-flight is dropped, never shown (ultrareview bug_001)", async () => {
    // Deferred response so the edit happens while the check is still pending —
    // the async race the sync onChange reset cannot cover: the late response
    // would otherwise override the reset and show A's name beside B's number.
    let resolveCheck: (r: { found: true; displayName: string }) => void = () => {};
    checkAccountMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));

    // Operator moves on to a different DNI while the server is still thinking.
    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "40999888" } });

    // The stale response for the OLD number lands now.
    await act(async () => {
      resolveCheck({ found: true, displayName: "Juana Pérez" });
    });

    expect(screen.queryByText("Cuenta encontrada: Juana Pérez")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeDisabled();
  });

  it("the application path is NOT gated by the DNI check", () => {
    render(<FinalizeAdoptionForm {...BASE_PROPS} />);
    expect(screen.getByRole("button", { name: "Finalizar adopción" })).toBeEnabled();
  });
});

describe("<FinalizeAdoptionForm> — contract print (org-pilot-pack C2)", () => {
  it("print form and button are ABSENT before the DNI check succeeds", () => {
    const { container } = render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);
    expect(
      screen.queryByRole("button", { name: "Imprimir modelo de contrato" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("#adoption-contract-print")).toBeNull();
  });

  it("found panel enables the print button targeting the sibling POST form in a new tab", async () => {
    checkAccountMock.mockResolvedValue({ found: true, displayName: "Juana Pérez" });

    const { container } = render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);
    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));
    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });

    const printButton = screen.getByRole("button", { name: "Imprimir modelo de contrato" });
    expect(printButton).toBeEnabled();
    // The button submits the SIBLING form (forms can't nest).
    expect(printButton).toHaveAttribute("form", "adoption-contract-print");

    const printForm = container.querySelector("#adoption-contract-print");
    expect(printForm).not.toBeNull();
    expect(printForm).toHaveAttribute("method", "post");
    expect(printForm).toHaveAttribute("target", "_blank");
    expect(printForm).toHaveAttribute(
      "action",
      "/org/org-tok/mascotas/DIM-1234-5678/adoption/contrato",
    );
    // DNI travels in the POST body (hidden input), never a query string.
    const dniInput = printForm?.querySelector('input[name="adopterDni"]');
    expect(dniInput).toHaveAttribute("value", "30111222");
  });

  it("the existing signed-copy upload field is untouched (spec 3.3 regression check)", () => {
    const { container } = render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);
    const upload = container.querySelector('input[name="contract"]');
    expect(upload).not.toBeNull();
    expect(upload).toHaveAttribute("type", "file");
    expect(upload).toHaveAttribute("accept", "application/pdf,image/*");
    expect(screen.getByText("Contrato firmado (PDF o imagen)")).toBeInTheDocument();
  });
});
