// @vitest-environment jsdom
//
// The institutional create forms ask for the address twice (security review,
// pilot T1-P3). Creating the account MAILS its access link to what was typed,
// so a typo is not a bounce: it can hand a govt/admin/national account to a
// stranger. These tests pin that a mismatch never reaches the server action.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createAction } = vi.hoisted(() => ({
  createAction: vi.fn(async () => ({
    ok: true as const,
    profileId: "00000000-0000-4000-8000-000000000001",
    magicLink: "",
    inviteEmailSent: true,
  })),
}));

vi.mock("@/app/actions/admin-institutional", () => ({
  createInstitutionalAccountAction: createAction,
}));
vi.mock("@/lib/ui/action-feedback", () => ({ notifySaved: vi.fn() }));
vi.mock("@/components/LocalityPickerAcross", () => ({ LocalityPickerAcross: () => null }));

import { CreateAdminForm } from "@/app/admin/admins/new/CreateAdminForm";
import { CreateGovtForm } from "@/app/admin/govts/new/CreateGovtForm";

afterEach(() => {
  cleanup();
  createAction.mockClear();
});

function fill(container: HTMLElement, email: string, confirmation: string) {
  const byId = (id: string) => {
    const el = container.querySelector(`#${id}`);
    if (!el) throw new Error(`#${id} not rendered`);
    return el;
  };
  fireEvent.change(byId("email"), { target: { value: email } });
  fireEvent.change(byId("emailConfirmation"), { target: { value: confirmation } });
  fireEvent.change(byId("displayName"), { target: { value: "Cuenta de prueba" } });
}

describe("institutional create forms — the address is typed twice", () => {
  it("admin: a mismatched confirmation is refused before the action is called", async () => {
    const { container } = render(<CreateAdminForm />);
    fill(container, "nuevo.admin@dim.gob.ar", "nuevo.admim@dim.gob.ar");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(
      await screen.findByText(
        "Los dos correos no coinciden. Revisalos: el link de acceso se manda a esa dirección.",
      ),
    ).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("admin: a matching confirmation goes through (non-vacuity)", async () => {
    const { container } = render(<CreateAdminForm />);
    fill(container, "nuevo.admin@dim.gob.ar", "Nuevo.Admin@dim.gob.ar");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await vi.waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin", email: "nuevo.admin@dim.gob.ar" }),
    );
  });

  it("national observer (govt form): a mismatch is refused before the action is called", async () => {
    const { container } = render(<CreateGovtForm />);
    fireEvent.click(container.querySelector('input[value="national"]') as HTMLInputElement);
    fill(container, "observa@nacion.gob.ar", "observa@nacion.gov.ar");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(await screen.findByText(/Los dos correos no coinciden/)).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("govt form: an empty confirmation is refused with its own message", async () => {
    const { container } = render(<CreateGovtForm />);
    fill(container, "operador@municipio.gob.ar", "");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(
      await screen.findByText("Escribí el correo de nuevo para confirmarlo."),
    ).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });
});
