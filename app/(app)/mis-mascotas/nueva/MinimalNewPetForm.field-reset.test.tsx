// @vitest-environment jsdom
//
// MinimalNewPetForm's own header comment claimed it "sidesteps the React 19
// uncontrolled-<form action> auto-reset (text fields are also controlled via
// useState for reset-safety)" — true for text, and WRONG for the rest.
// `breed`, `acquisitionMethod` and the "otra especie" sub-select were
// CONTROLLED selects (value+onChange); `sex` was a CONTROLLED radio group
// (checked+onChange). Per __tests__/react19-form-reset-contract.test.tsx a
// controlled select or radio is reset ANYWAY — react-dom only writes
// defaultSelected/defaultChecked on mount — so a rejected createPetAction
// call silently dropped the breed, sex and acquisition method the owner had
// just picked. `useKeptFields` fixes all four.
//
// Real submit via `form.requestSubmit()`.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";
import type { NewPetFormState } from "@/src/modules/pets/domain/types";

const searchMock = vi.fn();

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
}));

vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(),
  geocodeAddressPublicAction: vi.fn(),
  reverseGeocodeAction: vi.fn(),
  reverseGeocodePublicAction: vi.fn(),
}));

import { MinimalNewPetForm } from "./MinimalNewPetForm";

function makeResult(
  localityName: string,
  provinceCode: string,
  provinceName: string,
  indecId: string,
): LocalitySearchResult {
  return {
    id: `id-${indecId}`,
    indecId,
    provinceCode: provinceCode as LocalitySearchResult["provinceCode"],
    departmentName: null,
    departmentCode: null,
    localityName,
    localitySlug: localityName.toLowerCase().replace(/\s+/g, "-"),
    category: "localidad",
    provinceName,
    matchKind: "exact",
  };
}

/** Fill nombre + especie(dog) + a resolved localidad so paso 1 can advance. */
async function completeStep1() {
  fireEvent.change(screen.getByLabelText(/^nombre/i), { target: { value: "Pampa" } });
  fireEvent.click(screen.getByRole("button", { name: /^perro$/i }));

  fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });
  fireEvent.change(screen.getByLabelText(/Ciudad, pueblo o barrio/), { target: { value: "Bel" } });
  fireEvent.mouseDown(await screen.findByText("Belgrano"));
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({ results: [makeResult("Belgrano", "AR-C", "CABA", "02000020")] });
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:vitest-mock";
    URL.revokeObjectURL = () => {};
  }
});

afterEach(cleanup);

describe("<MinimalNewPetForm> — survives the React 19 post-error reset", () => {
  it("keeps breed, sex and acquisitionMethod after a rejected submit", async () => {
    const action = vi.fn(async (): Promise<NewPetFormState> => ({ error: "No se pudo crear." }));
    const { container } = render(<MinimalNewPetForm action={action} />);
    await completeStep1();

    const breed = screen.getByLabelText(/^raza/i) as HTMLSelectElement;
    fireEvent.change(breed, { target: { value: "Labrador" } });

    const maleRadio = container.querySelector(
      'input[name="sex"][value="male"]',
    ) as HTMLInputElement;
    fireEvent.click(maleRadio);
    expect(maleRadio.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));

    // Paso 2 — pick an acquisitionMethod inside "Más datos (opcional)".
    fireEvent.click(screen.getByText("Más datos (opcional)"));
    const acquisition = container.querySelector(
      'select[name="acquisitionMethod"]',
    ) as HTMLSelectElement;
    fireEvent.change(acquisition, { target: { value: "adopted" } });

    const form = container.querySelector("form") as HTMLFormElement;
    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo crear.");

    // Re-queried: the select `key` change remounts it once the reset lands,
    // so the earlier node is detached — that remount is the fix.
    expect((screen.getByLabelText(/^raza/i) as HTMLSelectElement).value).toBe("Labrador");
    expect(
      (container.querySelector('input[name="sex"][value="male"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (container.querySelector('select[name="acquisitionMethod"]') as HTMLSelectElement).value,
    ).toBe("adopted");
  });

  it("keeps the 'otra especie' sub-select after a rejected submit", async () => {
    const action = vi.fn(async (): Promise<NewPetFormState> => ({ error: "No se pudo crear." }));
    const { container } = render(<MinimalNewPetForm action={action} />);

    fireEvent.change(screen.getByLabelText(/^nombre/i), { target: { value: "Pipo" } });
    fireEvent.click(screen.getByRole("button", { name: /^otra$/i }));
    const otherSpecies = screen.getByLabelText(/¿cuál\?/i) as HTMLSelectElement;
    fireEvent.change(otherSpecies, { target: { value: "rabbit" } });

    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });
    fireEvent.change(screen.getByLabelText(/Ciudad, pueblo o barrio/), {
      target: { value: "Bel" },
    });
    fireEvent.mouseDown(await screen.findByText("Belgrano"));
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));

    const form = container.querySelector("form") as HTMLFormElement;
    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo crear.");

    expect((screen.getByLabelText(/¿cuál\?/i) as HTMLSelectElement).value).toBe("rabbit");
  });
});
