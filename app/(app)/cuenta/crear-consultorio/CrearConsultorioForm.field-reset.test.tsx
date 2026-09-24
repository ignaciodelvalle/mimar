// @vitest-environment jsdom
//
// forms/react19-reset-data-loss-inventory #5: CrearConsultorioForm is a
// 3-step wizard living in ONE <form> — steps stay mounted (sr-only + inert),
// never unmounted — so an error on step 3 reset the WHOLE form, wiping the
// legal (step 1) and contact (step 2) data the person entered earlier.
// `useKeptFields` re-seeds every field regardless of which step renders it.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/upgrade", () => ({
  createClinicAction: (...args: unknown[]) => actionMock(...args),
}));

// LocationFields pulls in geocoding fetch/dynamic-import machinery irrelevant
// here (same technique as signup-form-field-state.test.tsx).
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { CrearConsultorioForm } from "./CrearConsultorioForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<CrearConsultorioForm> — survives the React 19 post-error reset", () => {
  it("keeps step 1 and step 2 fields after an error surfaced on step 3", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo crear el consultorio." });

    const { container } = render(<CrearConsultorioForm defaultName="Mi consultorio" />);

    const name = container.querySelector('input[name="name"]') as HTMLInputElement;
    const legalName = container.querySelector('input[name="legalName"]') as HTMLInputElement;
    const cuit = container.querySelector('input[name="cuit"]') as HTMLInputElement;

    fireEvent.change(name, { target: { value: "Consultorio San Martín" } });
    fireEvent.change(legalName, { target: { value: "San Martín Veterinaria SRL" } });
    fireEvent.change(cuit, { target: { value: "20712345679" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Continuar" })[0]);

    const email = container.querySelector('input[name="email"]') as HTMLInputElement;
    const phone = container.querySelector('input[name="phone"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: "contacto@sanmartin.vet" } });
    fireEvent.change(phone, { target: { value: "+54 11 4444-2222" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Continuar" })[0]);

    const form = container.querySelector("form") as HTMLFormElement;
    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo crear el consultorio.");

    expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe(
      "Consultorio San Martín",
    );
    expect((container.querySelector('input[name="legalName"]') as HTMLInputElement).value).toBe(
      "San Martín Veterinaria SRL",
    );
    expect((container.querySelector('input[name="cuit"]') as HTMLInputElement).value).toBe(
      "20712345679",
    );
    expect((container.querySelector('input[name="email"]') as HTMLInputElement).value).toBe(
      "contacto@sanmartin.vet",
    );
    expect((container.querySelector('input[name="phone"]') as HTMLInputElement).value).toBe(
      "+54 11 4444-2222",
    );
  });
});
