// @vitest-environment jsdom
//
// "Editar datos" on the web, by section (owner-pet-actions, PO 2026-10-01):
// the six sections the app's edit screen shows, in the same order, each with
// its own Guardar and its own `seccion` anchor. Exercised through the public
// <PetForm existingPet=…> — the edit sheet and /editar render nothing else.
//
// WHAT A GUARDAR SAVES ON THE WEB. The form is one <form> and every Guardar
// submits it whole: `updatePetAction` writes the whole row, so a field left out
// of the post would be a field wiped. The section's button decides where the
// person is and where an error lands, not what is written.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import {
  PET_ACTION_INERT_CAPTIONS,
  PET_PROFILE_EDIT_SECTIONS,
  petAgeFromBirthDate,
} from "@dim/contract/reference";

const actionMock = vi.fn();

const PET = {
  publicToken: "DIM-PAMP-0001",
  species: "dog",
  name: "Pampa",
  sex: "female",
  breed: "Caniche",
  color: "Atigrada",
  dateOfBirth: "2021-03-04",
  birthDateIsEstimated: false,
  estimatedWeightKg: "18.50",
  favouriteFoods: ["Dieta casera"],
  knownAllergies: ["Pollo"],
  trainingLevel: "basic",
  permanentConditions: [],
  permanentConditionsOther: null,
  discloseConditionsPublicly: false,
  emergencyInfoVisible: false,
  insuranceCompany: "Sancor Seguros",
  insurancePolicyNumber: "POL-1",
  acquisitionMethod: "adopted",
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
} as unknown as Pet;

const SECTION_IDS = PET_PROFILE_EDIT_SECTIONS.map((s) => `seccion-${s.id}`);

function sectionOf(container: HTMLElement, id: string): HTMLElement {
  const section = container.querySelector(`#seccion-${id}`) as HTMLElement | null;
  expect(section, `section ${id} is on the form`).not.toBeNull();
  return section as HTMLElement;
}

beforeEach(() => {
  actionMock.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Editar datos on the web — the app's six sections, in its order", () => {
  it("draws the six sections in the shared order, each titled and anchored", () => {
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    const anchored = [...container.querySelectorAll("section[id^='seccion-']")]
      .map((s) => s.id)
      .filter((id) => SECTION_IDS.includes(id));
    expect(anchored).toEqual(SECTION_IDS);
    for (const section of PET_PROFILE_EDIT_SECTIONS) {
      const el = sectionOf(container, section.id);
      expect(within(el).getByRole("heading", { name: section.title })).toBeInTheDocument();
    }
  });

  it("gives every saving section its own Guardar, named after the section", () => {
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    for (const section of PET_PROFILE_EDIT_SECTIONS) {
      const el = sectionOf(container, section.id);
      if (section.saveLabel === null) {
        expect(within(el).queryByRole("button", { name: /^Guardar/ })).toBeNull();
      } else {
        expect(within(el).getByRole("button", { name: section.saveLabel })).toHaveAttribute(
          "type",
          "submit",
        );
      }
    }
  });

  it("saves the WHOLE form from any section — the writer stores every column", async () => {
    actionMock.mockResolvedValue({ error: null });
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    const seguro = sectionOf(container, "seguro");
    fireEvent.click(within(seguro).getByRole("button", { name: /Guardar/ }));
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    const formData = actionMock.mock.calls[0]?.[1] as FormData;
    // The section pressed, and the others, untouched, all ride along.
    expect(formData.get("insuranceCompany")).toBe("Sancor Seguros");
    expect(formData.get("name")).toBe("Pampa");
    expect(formData.get("estimatedWeightKg")).toBe("18.50");
    expect(formData.get("acquisitionMethod")).toBe("adopted");
  });

  it("shows a refused save inside the section whose Guardar was pressed", async () => {
    actionMock.mockResolvedValue({ error: "El número de póliza es demasiado largo." });
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    const seguro = sectionOf(container, "seguro");
    fireEvent.click(within(seguro).getByRole("button", { name: /Guardar/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("El número de póliza es demasiado largo.");
    expect(seguro).toContainElement(alert);
  });
});

describe("Editar datos on the web — Contactos opens its own sheet", () => {
  it("links to the emergency-contacts sheet when the viewer may edit them", () => {
    const href = "/mis-mascotas/DIM-PAMP-0001?sheet=emergencia";
    const { container } = render(
      <PetForm action={actionMock} existingPet={PET} contactsHref={href} />,
    );
    const link = within(sectionOf(container, "contactos")).getByRole("link");
    expect(link).toHaveAttribute("href", href);
  });

  it("says why when they may not — the titular's own vet and person to call", () => {
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    const contactos = sectionOf(container, "contactos");
    expect(within(contactos).queryByRole("link")).toBeNull();
    expect(contactos).toHaveTextContent(PET_ACTION_INERT_CAPTIONS.titular_only);
  });
});

describe("Editar datos on the web — landing on a section", () => {
  it("scrolls to the section the link asked for", () => {
    const { container } = render(
      <PetForm action={actionMock} existingPet={PET} initialSection="seguro" />,
    );
    const seguro = sectionOf(container, "seguro");
    expect(seguro.scrollIntoView).toHaveBeenCalled();
  });

  it("scrolls nowhere for a section it does not have", () => {
    render(<PetForm action={actionMock} existingPet={PET} initialSection="inexistente" />);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("Editar datos on the web — the age is read on Argentina's calendar", () => {
  it("shows the age the stored date reads as in Argentina, not in the browser's zone", () => {
    // 01:30 UTC on Oct 1 is still Sep 30 in Argentina: a dog born Oct 1, 2025
    // is eleven months old there, and a browser reading UTC would call it one.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T01:30:00Z"));
    const pet = { ...PET, dateOfBirth: "2025-10-01" } as Pet;
    const { container } = render(<PetForm action={actionMock} existingPet={pet} />);
    const expected = petAgeFromBirthDate("2025-10-01", new Date());
    expect(expected).toEqual({ years: 0, months: 11 });
    expect((container.querySelector('input[name="ageYears"]') as HTMLInputElement).value).toBe("0");
    expect((container.querySelector('input[name="ageMonths"]') as HTMLInputElement).value).toBe(
      "11",
    );
  });
});

describe("Editar datos on the web — what is not a section still rides the save", () => {
  it("keeps the weight, the microchip and the locality in Otros datos", () => {
    const { container } = render(<PetForm action={actionMock} existingPet={PET} />);
    const otros = container.querySelector("#seccion-otros") as HTMLElement;
    expect(otros).not.toBeNull();
    expect((otros.querySelector('input[name="estimatedWeightKg"]') as HTMLInputElement).value).toBe(
      "18.50",
    );
    expect(otros.querySelector('input[name="microchipId"]')).not.toBeNull();
    expect(otros.querySelector('input[name="localityName"]')).not.toBeNull();
  });
});
