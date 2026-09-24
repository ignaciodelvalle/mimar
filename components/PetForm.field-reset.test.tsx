// @vitest-environment jsdom
//
// PetForm had SEVEN unsafe <select>s sharing the same defect: "sex" had a
// static defaultValue and no changing key; speciesGroup/speciesSubgroup/
// breed/trainingLevel/acquisitionMethod/microchipLocation were CONTROLLED
// (value=+onChange=) with no key — never safe on its own for a <select>,
// even though onChange fires on every pick: react-dom only writes an
// <option>'s `selected` attribute (what a native form.reset() reads) on the
// MOUNT path, and a controlled select never takes that path again on a
// value change. Fixed the same way LegalMetadataFieldset's requirement-tier
// select and NoteForm's category select were: defaultValue+key from the
// SAME plain React state (not kept(), since these are live UI state read by
// other derived logic in this file — breed options, the "raza peligrosa"
// warning — not simple pass-through form fields). This test exercises two
// of the seven ("sex" and "breed") as the representative shapes; all seven
// use the identical defaultValue+key mechanism, already covered generically
// by __tests__/react19-form-reset-contract.test.tsx's "counter-intuitive
// pair".
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: () => Promise.resolve([]),
  searchLocalitiesPublicAction: () => Promise.resolve([]),
}));

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));

import { PetForm } from "@/components/PetForm";
import type { Pet } from "@/db";

const actionMock = vi.fn();

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<PetForm> — the species cascade", () => {
  it("renders the subgroup select the moment 'Otra' is picked, and both survive a rejected submit — fresh-context review, T4-F1 batches 3-4", async () => {
    // create mode: no existingPet, speciesGroup/speciesSubgroup are only
    // rendered here (edit mode shows the read-only, FULL-LOCK species field).
    actionMock.mockResolvedValue({ error: "No se pudo crear la mascota." });
    const { container } = render(<PetForm action={actionMock} />);

    const name = container.querySelector('input[name="name"]') as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Firulais" } });

    const speciesGroup = container.querySelector(
      'select[name="speciesGroup"]',
    ) as HTMLSelectElement;
    fireEvent.change(speciesGroup, { target: { value: "other" } });

    // THE BUG: the onChange handler used to call setSpecies("") for "other"
    // too — the SAME value species already starts at — so speciesGroup
    // (derived from species) never actually moved off "", and this select
    // never rendered at all. No submit needed to see it: it either renders
    // right now, or it never will.
    const speciesSubgroup = container.querySelector(
      'select[name="speciesSubgroup"]',
    ) as HTMLSelectElement | null;
    expect(speciesSubgroup).not.toBeNull();

    fireEvent.change(speciesSubgroup as HTMLSelectElement, { target: { value: "rabbit" } });
    expect((speciesSubgroup as HTMLSelectElement).value).toBe("rabbit");

    // Location is unrelated to what this test proves, and the mocked search
    // action returns no results to pick from (same as every other PetForm
    // test here) — bypass its native required constraints the same way
    // TattooForm.field-reset.test.tsx bypasses its required file input.
    const province = container.querySelector("#cascade-province") as HTMLSelectElement;
    province.removeAttribute("required");
    const locality = container.querySelector("#localityName-input") as HTMLInputElement;
    locality.removeAttribute("required");

    const form = container.querySelector("form") as HTMLFormElement;
    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo crear la mascota.");

    // Both survive: the subgroup section is still reachable (speciesGroup is
    // plain React state — untouched by a DOM form.reset() — so it stays
    // "other" regardless of the select fix) AND the select the person
    // actually used still shows their pick, not a blank "Elegí una".
    expect(
      container.querySelector('select[name="speciesSubgroup"]') as HTMLSelectElement | null,
    ).not.toBeNull();
    expect(
      (container.querySelector('select[name="speciesSubgroup"]') as HTMLSelectElement).value,
    ).toBe("rabbit");
    expect(
      (container.querySelector('select[name="speciesGroup"]') as HTMLSelectElement).value,
    ).toBe("other");
  });
});

describe("<PetForm> — survives the React 19 post-error reset", () => {
  it("keeps the picked sex after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la mascota." });
    const existingPet = {
      species: "dog",
      name: "Firulais",
      sex: "unknown",
    } as Pet;
    const { container } = render(<PetForm action={actionMock} existingPet={existingPet} />);

    const sex = container.querySelector('select[name="sex"]') as HTMLSelectElement;
    const breed = container.querySelector('select[name="breed"]') as HTMLSelectElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(sex, { target: { value: "female" } });
    fireEvent.change(breed, { target: { value: "Mixto / Cruza" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la mascota.");

    expect((container.querySelector('select[name="sex"]') as HTMLSelectElement).value).toBe(
      "female",
    );
    expect((container.querySelector('select[name="breed"]') as HTMLSelectElement).value).toBe(
      "Mixto / Cruza",
    );
  });
});
