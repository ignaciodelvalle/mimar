// @vitest-environment jsdom
//
// forms/react19-reset-data-loss-inventory #4: "nombre y teléfono del
// adoptante sin `value` ni `defaultValue`". React 19 resets the form once
// `finalizeAdoptionAction` settles — including on a server-side error after
// the DNI check has already passed — and both fields had nothing to restore
// from. `useKeptFields` re-seeds them from the FormData actually submitted.
//
// T4-F1 batch 2 adds the residual this form's batch-1 fix flagged but did not
// cover: `__appChoice` (a controlled radio choosing which approved
// application to finalize) and `useFosterShortcut` (a controlled checkbox)
// both fall back to their MOUNT value on the same reset — a person who picks
// the second applicant, or who opts OUT of the foster shortcut onto the
// manual-DNI path, sees their pick silently reverted the moment a server
// error lands. Fixed with `defaultChecked` + a `key` derived from the
// controlling React state (not FormData — this is parent state, not a
// submission echo), the same technique LegalMetadataFieldset's select used.
//
// Real submit via a click on the real submit button (or `form.requestSubmit`)
// — see __tests__/react19-form-reset-contract.test.tsx for why a dispatched
// `submit` Event does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

import { FinalizeAdoptionForm } from "./FinalizeAdoptionForm";

const SIGNUP_QR_SVG = '<svg role="img" aria-label="signup-qr"><title>signup-qr</title></svg>';

const MANUAL_DNI_PROPS = {
  orgToken: "org-tok",
  publicToken: "DIM-1234-5678",
  fosterShortcut: null,
  approvedApplications: [],
  signupQrSvg: SIGNUP_QR_SVG,
};

beforeEach(() => {
  actionMock.mockReset();
  checkAccountMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<FinalizeAdoptionForm> — survives the React 19 post-error reset", () => {
  it("keeps the adopter name and phone after a rejected submit", async () => {
    checkAccountMock.mockResolvedValue({ found: true, displayName: "Juana Pérez" });
    actionMock.mockResolvedValue({ error: "No se pudo finalizar la adopción." });

    const { container } = render(<FinalizeAdoptionForm {...MANUAL_DNI_PROPS} />);

    fireEvent.change(screen.getByLabelText(/DNI/), { target: { value: "30111222" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));
    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });

    const name = container.querySelector('input[name="adopterDisplayName"]') as HTMLInputElement;
    const phone = container.querySelector('input[name="adopterPhone"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(name, { target: { value: "Juana Pérez" } });
    fireEvent.change(phone, { target: { value: "+54 11 5555-1234" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo finalizar la adopción.");

    expect(
      (container.querySelector('input[name="adopterDisplayName"]') as HTMLInputElement).value,
    ).toBe("Juana Pérez");
    expect((container.querySelector('input[name="adopterPhone"]') as HTMLInputElement).value).toBe(
      "+54 11 5555-1234",
    );
  });

  it("keeps a non-default __appChoice radio pick after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo finalizar la adopción." });
    const props = {
      orgToken: "org-tok",
      publicToken: "DIM-1234-5678",
      fosterShortcut: null,
      approvedApplications: [
        { applicationEventId: "app-1", applicantName: "Juana" },
        { applicationEventId: "app-2", applicantName: "Marcos" },
      ],
      signupQrSvg: SIGNUP_QR_SVG,
    };

    render(<FinalizeAdoptionForm {...props} />);

    // Mount default is the FIRST application — pick the second on purpose,
    // the way the contract test's radio fixture differs mount from current.
    const second = screen.getByLabelText("Marcos") as HTMLInputElement;
    fireEvent.click(second);
    expect(second.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Finalizar adopción" }));
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo finalizar la adopción.");

    expect((screen.getByLabelText("Marcos") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Juana") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps useFosterShortcut UNCHECKED (opted into manual DNI) after a rejected submit", async () => {
    checkAccountMock.mockResolvedValue({ found: true, displayName: "Juana Pérez" });
    actionMock.mockResolvedValue({ error: "No se pudo finalizar la adopción." });
    const props = {
      orgToken: "org-tok",
      publicToken: "DIM-1234-5678",
      fosterShortcut: { adopterUserId: "user-1", displayName: "Voluntario X" },
      approvedApplications: [],
      signupQrSvg: SIGNUP_QR_SVG,
    };

    const { container } = render(<FinalizeAdoptionForm {...props} />);

    // Mount default is CHECKED (fosterShortcut present) — the operator opts
    // OUT, onto the manual-DNI path, which is the case that matters: a reset
    // that silently re-ticks this hides the DNI section they were filling.
    const shortcut = screen.getByLabelText(/Finalizar adopción al tránsito actual/i);
    fireEvent.click(shortcut);
    expect((shortcut as HTMLInputElement).checked).toBe(false);

    fireEvent.change(container.querySelector('input[name="adopterDni"]') as HTMLInputElement, {
      target: { value: "30111222" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar cuenta" }));
    await waitFor(() => {
      expect(screen.getByText("Cuenta encontrada: Juana Pérez")).toBeInTheDocument();
    });
    fireEvent.change(
      container.querySelector('input[name="adopterDisplayName"]') as HTMLInputElement,
      { target: { value: "Juana Pérez" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Finalizar adopción" }));
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo finalizar la adopción.");

    expect(
      (screen.getByLabelText(/Finalizar adopción al tránsito actual/i) as HTMLInputElement).checked,
    ).toBe(false);
    // The manual-DNI section is still showing (not silently swapped back).
    expect(container.querySelector('input[name="adopterDni"]')).toBeInTheDocument();
  });
});
