// `PetProfileEditScreen` — the render tests for the first native screen that
// CORRECTS something the app already recorded, sectioned since owner-pet-actions.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE HALVES ARE GATED SEPARATELY, from `capabilities` and never from "this
//      pet is mine". The case that matters is the FOSTER: allowed to correct
//      the animal's data, not allowed anywhere near the titular's own vet and
//      phone. A screen that reasoned from one flag gets exactly this person
//      wrong.
//   2. NO CONTROL IS OFFERED THAT CAN ONLY BE REFUSED. Where a flag is false the
//      screen renders the REASON, not a disabled form and not a form whose save
//      answers 403.
//   3. EACH SECTION'S GUARDAR SENDS ITS OWN SECTION and `null` for the rest, and
//      re-seeds only that section from the server, so what was typed in another
//      section survives the save.
//   4. THE AGE IS POSTED BACK AS SHOWN, so an untouched age keeps the stored
//      birth date (the drift the web had).
//   5. "NOTHING CHANGED" IS SAID OUT LOUD rather than dressed as success.
//   6. THE STORED BREED IS REACHABLE even when the catalog has lost it (QA A5).
//   7. A LINK THAT NAMES A SECTION OPENS THE SCREEN ON IT (`?seccion=`).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, Keyboard, ScrollView } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";
import { SPACE } from "../ui/theme";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY — a stable object and a working unsubscribe. See
// `ui/navigation-fake.ts`; a `useNavigation` stub that never fires its listener
// makes a missing discard guard invisible.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchPetProfileEdit: (...args: unknown[]) => mockFetch(...args),
  sendPetProfileCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { PetProfileDraftV1, PetProfileEditV1 } from "@dim/contract/api";
import {
  PET_ALLERGY_ENTRY_MAX,
  PET_CONDITION_OTHER_MAX,
  PET_INSURANCE_COMPANY_MAX,
  PET_INSURANCE_POLICY_MAX,
  PET_PROFILE_TEXT_LENGTH_MESSAGES,
} from "@dim/contract/input";
import { PET_PROFILE_EDIT_SECTIONS } from "@dim/contract/reference";

import { PetProfileEditScreen } from "./PetProfileEditScreen";

const TOKEN = "DIM-PAMP-0001";

/**
 * The profile block. No birth date by default, so nothing on screen depends on
 * the day the suite runs; the age round trip has its own test.
 */
const PROFILE: PetProfileDraftV1 = {
  sex: "female",
  dateOfBirth: null,
  birthDateIsEstimated: false,
  favouriteFoods: ["Comida seca (balanceada)"],
  knownAllergies: ["Pollo"],
  trainingLevel: "basic",
  permanentConditions: [],
  permanentConditionsOther: null,
  emergencyInfoVisible: true,
  discloseConditionsPublicly: false,
  insuranceCompany: "Mapfre Mascotas",
  insurancePolicyNumber: "POL-123",
  acquisitionMethod: "adopted",
};

const ALL_ALLOWED = {
  canEditIdentity: true,
  canEditEmergencyContacts: true,
  canCorrectSpecies: true,
  canTogglePhysicalTagInterest: true,
  canManageServiceDog: true,
  canEditProfile: true,
};

function payload(over: Partial<PetProfileEditV1> = {}): PetProfileEditV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-29T10:00:00.000Z",
    staleAfter: "2026-08-29T10:01:00.000Z",
    publicToken: TOKEN,
    species: "dog",
    identity: { name: "Pampa", breed: "Mestizo", color: "Atigrada" },
    emergencyContacts: {
      preferredVetName: "Vet Norte",
      preferredVetPhone: "1122334455",
      emergencyContactName: "",
      emergencyContactPhone: "",
    },
    emergencyAccountDefault: {
      preferredVetName: null,
      preferredVetPhone: null,
      emergencyContactName: "Mamá",
      emergencyContactPhone: "1199887766",
    },
    capabilities: ALL_ALLOWED,
    physicalTagInterest: { interested: false, requestedAt: null },
    serviceDog: { designation: null },
    profile: PROFILE,
    ...over,
  } as PetProfileEditV1;
}

/** `edit_profile` with every section null but the ones given. */
const onlySection = (sections: Record<string, unknown>) => ({
  command: "edit_profile",
  identity: null,
  health: null,
  publicCredential: null,
  insurance: null,
  origin: null,
  ...sections,
});

/**
 * Every string the screen renders, in reading order — exact text nodes, so a
 * title cannot be "found" inside a placeholder or a hint that mentions it.
 */
function readingOrder(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === "object" && node !== null && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(screen.toJSON());
  return out;
}

/** The identity section as the default fixture posts it, untouched. */
const IDENTITY_AS_STORED = {
  name: "Pampa",
  breed: "Mestizo",
  color: "Atigrada",
  sex: "female",
  ageYears: null,
  ageMonths: null,
};

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockSend.mockResolvedValue({
    outcome: "ok",
    payload: { command: "edit_profile", changed: true },
  });
});

describe("PetProfileEditScreen — the six sections, in the plan's order", () => {
  it("draws Identidad, Salud y cuidados, Contactos, Qué muestra la credencial pública, Seguro, Origen", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    // Spelled out, AND equal to the contract's list the web form draws from: a
    // title the two platforms word differently is two sections to a reader.
    const titles = [
      "Identidad",
      "Salud y cuidados",
      "Contactos",
      "Qué muestra la credencial pública",
      "Seguro",
      "Origen",
    ];
    expect(PET_PROFILE_EDIT_SECTIONS.map((section) => section.title)).toEqual(titles);
    const order = readingOrder();
    const at = titles.map((title) => order.indexOf(title));
    // Each title is on the screen, and after the one before it.
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("names each section's Guardar as the web form does, from the same list", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    const labels = PET_PROFILE_EDIT_SECTIONS.flatMap((section) =>
      section.saveLabel === null ? [] : [section.saveLabel],
    );
    // Five sections save fields; Contactos is a door on the web and a form of its
    // own here, so it keeps the app's "Guardar contactos".
    expect(labels).toHaveLength(5);
    for (const label of labels) expect(screen.getByText(label)).toBeOnTheScreen();
    expect(screen.getByText("Guardar lo que se muestra")).toBeOnTheScreen();
    expect(screen.getByText("Guardar contactos")).toBeOnTheScreen();
  });

  it("pre-fills every section from the server's own values", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByDisplayValue("Pampa")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("Atigrada")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("Vet Norte")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("Mapfre Mascotas")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("POL-123")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Hembra" }).props.accessibilityState.checked).toBe(
      true,
    );
    expect(screen.getByRole("checkbox", { name: "Pollo" }).props.accessibilityState.checked).toBe(
      true,
    );
    expect(screen.getByRole("radio", { name: "Adopción" }).props.accessibilityState.checked).toBe(
      true,
    );
    expect(
      screen.getByLabelText("Mostrar aviso de emergencia médica en la credencial pública").props
        .value,
    ).toBe(true);
  });
});

describe("PetProfileEditScreen — the halves are gated separately", () => {
  it("gives a FOSTER the sections and refuses the contacts, with the reason", async () => {
    // THE CASE A SINGLE FLAG GETS WRONG. A foster is a Path-1 holder: they may
    // correct the animal's data and must not see the legal owner's vet and
    // phone (the writer's join says role='owner').
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          ...ALL_ALLOWED,
          canEditEmergencyContacts: false,
          canManageServiceDog: false,
        },
        emergencyContacts: null,
        emergencyAccountDefault: null,
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByDisplayValue("Pampa")).toBeOnTheScreen();
    // The forms that ARE theirs are live…
    expect(screen.getByText("Guardar identidad")).toBeOnTheScreen();
    expect(screen.getByText("Guardar seguro")).toBeOnTheScreen();
    // …and the one that is not shows a sentence instead of a control.
    expect(screen.queryByText("Guardar contactos")).toBeNull();
    expect(screen.getByText(/Solo esa persona puede cambiarlos/)).toBeOnTheScreen();
  });

  it("refuses the identity form and the profile sections to a caretaker, each with its sentence", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          ...ALL_ALLOWED,
          canEditIdentity: false,
          canCorrectSpecies: false,
          canEditProfile: false,
        },
        profile: null,
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/solo del titular/)).toBeOnTheScreen();
    expect(screen.queryByText("Guardar identidad")).toBeNull();
    // Four sections, one reason each, and no control behind any of them.
    expect(screen.getAllByText(/Estos datos los edita el titular/)).toHaveLength(4);
    for (const save of [
      "Guardar salud y cuidados",
      "Guardar lo que se muestra",
      "Guardar seguro",
    ]) {
      expect([save, screen.queryByText(save)]).toEqual([save, null]);
    }
    // The other half is untouched by that refusal.
    expect(screen.getByText("Guardar contactos")).toBeOnTheScreen();
  });

  it("keeps the old three-field identity form where the server sends no profile block", async () => {
    // An org-path holder passes `canEditIdentity` and not `canEditProfile`; an
    // older server sends no `profile` at all. Either way the name, breed and
    // colour stay editable through the command they always used.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ capabilities: { ...ALL_ALLOWED, canEditProfile: false }, profile: null }),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "edit_identity", changed: true },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Pampa"), "Pampita");
    // No sex or age without the block — they would post to a command that has none.
    expect(screen.queryByRole("radio", { name: "Hembra" })).toBeNull();
    fireEvent.press(screen.getByText("Guardar identidad"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "edit_identity",
      name: "Pampita",
      breed: "Mestizo",
      color: "Atigrada",
    });
  });
});

describe("PetProfileEditScreen — the discard guard (A2-alta-asentar-08)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
    mockNav.reset();
  });

  it("does NOT ask anything of somebody who only opened the screen", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks before the back gesture discards an edited name", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Pampa"), "Pampita");

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });

  it("watches the CONTACTS half too, which saves separately", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Vet Norte"), "Vet Sur");
    expect(mockNav.pressBack().blocked).toBe(true);
  });

  it("watches a CHIP, which no text field records", async () => {
    // A shallow comparison of the section would call a new allergy unchanged.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByRole("checkbox", { name: "Cerdo" }));
    expect(mockNav.pressBack().blocked).toBe(true);
  });

  it("goes back to CLEAN once the save landed and the form was re-seeded", async () => {
    // The baseline is the SERVER'S payload, not a value captured at mount, so a
    // landed save makes the screen quiet again — a guard measuring against the
    // mount value would go on asking about an edit that is already stored.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Pampa"), "Pampita");
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: { name: "Pampita", breed: "Mestizo", color: "Atigrada" } }),
    });
    fireEvent.press(screen.getByText("Guardar identidad"));
    // WAIT ON THE RE-READ, not on the field: the input already shows "Pampita"
    // from the local edit, so `findByDisplayValue` resolves before the save has
    // even been sent and the assertion below would read a draft that is
    // genuinely still dirty.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("PetProfileEditScreen — each Guardar sends its own section", () => {
  it("Identidad: the five fields as typed, and nothing else", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Pampa"), "Pampita");
    fireEvent.press(screen.getByRole("radio", { name: "Macho" }));
    fireEvent.press(screen.getByText("Guardar identidad"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({ identity: { ...IDENTITY_AS_STORED, name: "Pampita", sex: "male" } }),
    );
  });

  it("Salud y cuidados: a chip and the typed rest", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByRole("checkbox", { name: "Cerdo" }));
    fireEvent.changeText(screen.getByLabelText("Otras alergias"), "Ácaros");
    fireEvent.press(screen.getByText("Guardar salud y cuidados"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({
        health: {
          favouriteFoods: ["Comida seca (balanceada)"],
          knownAllergies: ["Pollo", "Cerdo", "Ácaros"],
          trainingLevel: "basic",
          permanentConditions: [],
          permanentConditionsOther: null,
        },
      }),
    );
  });

  it("Salud y cuidados: 'Otra' asks for its description, and is refused locally without one", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    expect(screen.queryByLabelText("Especificá la condición, obligatorio")).toBeNull();
    fireEvent.press(screen.getByRole("checkbox", { name: "Otra (especificar)" }));
    expect(screen.getByLabelText("Especificá la condición, obligatorio")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Guardar salud y cuidados"));
    expect(await screen.findByText("Describí la otra condición.")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("Salud y cuidados: a NEW allergy past its cap is refused in the section, naming the field, and not posted", async () => {
    // The server answers this with a bare 400 and no field; the screen must say
    // which box, before the round trip (the contract's caps, e88c05c89).
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.changeText(
      screen.getByLabelText("Otras alergias"),
      "a".repeat(PET_ALLERGY_ENTRY_MAX + 1),
    );
    fireEvent.press(screen.getByText("Guardar salud y cuidados"));
    expect(
      await screen.findByText(PET_PROFILE_TEXT_LENGTH_MESSAGES.ALLERGY_TOO_LONG),
    ).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("Seguro: a NEW insurer past its cap is refused with its own sentence, and not posted", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(
      await screen.findByDisplayValue("Mapfre Mascotas"),
      "s".repeat(PET_INSURANCE_COMPANY_MAX + 1),
    );
    fireEvent.press(screen.getByText("Guardar seguro"));
    expect(
      await screen.findByText(PET_PROFILE_TEXT_LENGTH_MESSAGES.INSURANCE_COMPANY_TOO_LONG),
    ).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("caps the insurer, the policy and the 'otra' description at the contract's numbers", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect((await screen.findByDisplayValue("Mapfre Mascotas")).props.maxLength).toBe(
      PET_INSURANCE_COMPANY_MAX,
    );
    expect(screen.getByDisplayValue("POL-123").props.maxLength).toBe(PET_INSURANCE_POLICY_MAX);
    fireEvent.press(screen.getByRole("checkbox", { name: "Otra (especificar)" }));
    expect(screen.getByLabelText("Especificá la condición, obligatorio").props.maxLength).toBe(
      PET_CONDITION_OTHER_MAX,
    );
  });

  it("does not truncate an insurer longer than the cap invented after it", async () => {
    const legacy = "Aseguradora ".repeat(10).trim();
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ profile: { ...PROFILE, insuranceCompany: legacy } }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect((await screen.findByDisplayValue(legacy)).props.maxLength).toBe(legacy.length);

    // And the save carries it over, untouched, while the policy is corrected.
    fireEvent.changeText(screen.getByDisplayValue("POL-123"), "POL-999");
    fireEvent.press(screen.getByText("Guardar seguro"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({ insurance: { insuranceCompany: legacy, insurancePolicyNumber: "POL-999" } }),
    );
  });

  it("Qué muestra la credencial pública: the two toggles, alone", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent(
      screen.getByLabelText("Mostrar aviso de emergencia médica en la credencial pública"),
      "valueChange",
      false,
    );
    fireEvent.press(screen.getByText("Guardar lo que se muestra"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({
        publicCredential: { emergencyInfoVisible: false, discloseConditionsPublicly: false },
      }),
    );
  });

  it("Seguro: an emptied field clears it", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("POL-123"), "");
    fireEvent.press(screen.getByText("Guardar seguro"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({
        insurance: { insuranceCompany: "Mapfre Mascotas", insurancePolicyNumber: null },
      }),
    );
  });

  it("Origen: the method picked, or none with 'No especificar'", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByRole("radio", { name: "La encontré" }));
    fireEvent.press(screen.getByText("Guardar origen"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      onlySection({ origin: { acquisitionMethod: "found_stray" } }),
    );
  });

  it("keeps what was typed in ANOTHER section when one section's save lands", async () => {
    // Six Guardar buttons on one screen: a person fills Seguro, decides to save
    // Origen first, and must not find Seguro reset by the re-read.
    mockNav.reset();
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("POL-123"), "POL-999");
    fireEvent.press(screen.getByRole("radio", { name: "Regalo" }));
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ profile: { ...PROFILE, acquisitionMethod: "gift" } }),
    });
    fireEvent.press(screen.getByText("Guardar origen"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(screen.getByDisplayValue("POL-999")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Regalo" }).props.accessibilityState.checked).toBe(
      true,
    );
    // And the unsaved one is still unsaved, so the guard still asks.
    expect(mockNav.pressBack().blocked).toBe(true);
  });

  it("re-reads after a save instead of trusting the ack", async () => {
    // The server folds "pitbull" to "Pit Bull Terrier"; a screen that kept its
    // own draft would go on showing the lowercase string it sent.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: { name: "Pampita", breed: "Mestizo", color: "Atigrada" } }),
    });
    fireEvent.press(screen.getByText("Guardar identidad"));
    expect(await screen.findByDisplayValue("Pampita")).toBeOnTheScreen();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("says nothing needed saving when the server reports no change", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "edit_profile", changed: false },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByText("Guardar seguro"));
    expect(await screen.findByText(/nada que cambiar/)).toBeOnTheScreen();
  });

  it("refuses an empty name locally, and does not post it", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue("Pampa");
    fireEvent.changeText(name, "   ");
    fireEvent.press(screen.getByText("Guardar identidad"));
    expect(await screen.findByText(/El nombre no puede quedar vacío/)).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("PetProfileEditScreen — the age is posted back as shown", () => {
  it("sends the years and months the inputs hold, so an untouched age keeps the stored date", async () => {
    // THE DRIFT FIX, from the phone's side: the server keeps the stored birth
    // date when the posted age is the age that date reads as. Whatever the
    // inputs show is therefore what must leave the phone — a screen that
    // rounded, or re-derived the age at save time, would move the date.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ profile: { ...PROFILE, dateOfBirth: "2019-07-20" } }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    const years = screen.getByLabelText("Años").props.value as string;
    const months = screen.getByLabelText("Meses").props.value as string;
    // Non-vacuity: a stored date shows SOME age, not two empty boxes.
    expect(years).toMatch(/^\d+$/);
    expect(months).toMatch(/^\d+$/);

    fireEvent.press(screen.getByText("Guardar identidad"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({
        identity: { ...IDENTITY_AS_STORED, ageYears: Number(years), ageMonths: Number(months) },
      }),
    );
  });
});

describe("PetProfileEditScreen — the species and the contacts keep their own commands", () => {
  it("posts the species correction as its OWN command, never as a field of the identity edit", async () => {
    // FULL-LOCK (PO decision #40): the identity edit refuses the species, so the
    // card has its own chips and its own button, and what leaves the phone is
    // `correct_species` and nothing else.
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "correct_species", changed: true },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByRole("radio", { name: "Gato" }));
    fireEvent.press(screen.getByRole("button", { name: "Corregir especie" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "correct_species",
      species: "cat",
    });
  });

  it("says the species was already that when the server reports no change", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "correct_species", changed: false },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByRole("button", { name: "Corregir especie" }));
    expect(await screen.findByText(/no hay nada que corregir/)).toBeOnTheScreen();
  });

  it("renders the reason and no chips when the caller may not correct the species", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          canEditIdentity: false,
          canEditEmergencyContacts: false,
          canCorrectSpecies: false,
          canTogglePhysicalTagInterest: false,
          canManageServiceDog: false,
          canEditProfile: false,
        },
        profile: null,
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/La especie la corrige el titular/)).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Corregir especie" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Gato" })).toBeNull();
  });

  it("posts all four contact fields, so an emptied one clears the override", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "set_emergency_contacts", changed: true },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const vetName = await screen.findByDisplayValue("Vet Norte");
    fireEvent.changeText(vetName, "");
    fireEvent.press(screen.getByText("Guardar contactos"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "set_emergency_contacts",
      preferredVetName: "",
      preferredVetPhone: "1122334455",
      emergencyContactName: "",
      emergencyContactPhone: "",
    });
  });

  it("tells the person what the account will show behind a cleared pair", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    expect(screen.getByText(/Mamá/)).toBeOnTheScreen();
    // And is honest when there is nothing behind it.
    expect(screen.getByText(/tu cuenta tampoco tiene uno cargado/)).toBeOnTheScreen();
  });
});

describe("PetProfileEditScreen — opens on the section the link names (`?seccion=`)", () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
  const layoutAt = (y: number) => ({
    nativeEvent: { layout: { x: 0, y, width: 320, height: 400 } },
  });

  beforeEach(() => {
    scrollTo.mockClear();
  });

  it("scrolls to Contactos when the panel's Contactos row opened the screen", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} initialSection="contactos" />);
    await screen.findByDisplayValue("Pampa");
    // jest has no layout: the section reports where it landed, as Yoga would.
    fireEvent(screen.getByText("Contactos"), "layout", layoutAt(900));
    expect(scrollTo).toHaveBeenCalledWith({ y: 900 - SPACE.lg, animated: false });
  });

  it("does not scroll for a section the link did not name, nor when none was named", async () => {
    const named = render(<PetProfileEditScreen publicToken={TOKEN} initialSection="seguro" />);
    await screen.findByDisplayValue("Pampa");
    fireEvent(screen.getByText("Contactos"), "layout", layoutAt(900));
    expect(scrollTo).not.toHaveBeenCalled();
    named.unmount();

    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent(screen.getByText("Contactos"), "layout", layoutAt(900));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls ONCE — a later layout (a breed list growing above) does not yank the reader back", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} initialSection="contactos" />);
    await screen.findByDisplayValue("Pampa");
    const title = screen.getByText("Contactos");
    fireEvent(title, "layout", layoutAt(900));
    fireEvent(title, "layout", layoutAt(1300));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("PetProfileEditScreen — the breed the catalog forgot", () => {
  it("offers a stored off-catalog breed so a name edit cannot wipe it", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        identity: { name: "Pampa", breed: "Ovejero Inventado", color: null },
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    // TWICE, and both are load bearing: once as the current selection (the
    // chip with "Quitar"), and once in the option list, so a person who clears
    // it by accident can put it back. A picker that only offered the catalog
    // would make that second one impossible.
    const shown = await screen.findAllByText("Ovejero Inventado");
    expect(shown.length).toBe(2);
    expect(screen.getByText("Quitar")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Guardar identidad"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({
        identity: { ...IDENTITY_AS_STORED, breed: "Ovejero Inventado", color: null },
      }),
    );
  });
});

describe("PetProfileEditScreen — the breed picker does not dump the catalog (B-01)", () => {
  it("shows only the stored breed until somebody types, then the matches", async () => {
    // MEASURED on the shipped build 10 (shot 102): opening "Editar datos" drew
    // twelve breeds inline under the filter box and pushed COLOR and the save
    // button a full screen down. The list is an ANSWER to a query; with no
    // query there is nothing to answer. The one row kept is the animal's own
    // stored breed, so "Quitar" stays undoable without spelling it from memory.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: { name: "Pampa", breed: "Beagle", color: null } }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    // Two other catalog entries, absent on mount.
    expect(screen.queryByText("Akita Inu")).toBeNull();
    expect(screen.queryByText("Mixto / Cruza")).toBeNull();
    // And no "we found nothing" over a search nobody performed.
    expect(screen.queryByText("No encontramos esa raza en el catálogo.")).toBeNull();
    // The stored breed IS there — once in the chip, once as the row that puts
    // it back after a "Quitar".
    expect(screen.getAllByText("Beagle")).toHaveLength(2);

    fireEvent.changeText(screen.getByLabelText("Raza"), "akita");
    expect(screen.getByText("Akita Inu")).toBeOnTheScreen();
  });

  it.each([
    ["dalmata", "Dálmata"],
    ["frances", "Bulldog Francés"],
    ["GRAN danes", "Gran Danés"],
  ])("folds accents and case: typing %s finds %s (audit 2026-10-07)", async (typed, breed) => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: { name: "Pampa", breed: "Beagle", color: null } }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    fireEvent.changeText(screen.getByLabelText("Raza"), typed);
    expect(screen.getByText(breed)).toBeOnTheScreen();
  });

  it("names itself after its visible label, not 'Buscar raza' (WCAG 2.5.3)", async () => {
    // The same defect lote 1a fixed on LocationPicker: a voice user reading
    // "Raza" off the screen and saying it named nothing at all.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    expect(screen.getByLabelText("Raza")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Buscar raza")).toBeNull();
  });

  it("dismisses the keyboard when a breed is picked from the list (U-6)", async () => {
    // The keyboard the search field opened used to stay up after a row was
    // tapped, covering the chosen-breed chip this picker draws right above
    // the list it was just picked from.
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    fireEvent.changeText(screen.getByLabelText("Raza"), "akita");
    fireEvent.press(screen.getByText("Akita Inu"));

    expect(dismiss).toHaveBeenCalled();
  });
});

describe("PetProfileEditScreen — a name longer than the cap invented after it", () => {
  // `pets.name` is unbounded `text` and the web's parser caps it nowhere, so
  // over-long values already exist. This animal's owner has a phone and no
  // second door.
  const LONG_NAME = "Pampa ".repeat(30).trim();

  beforeEach(() => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ identity: { name: LONG_NAME, breed: "Mestizo", color: "Atigrada" } }),
    });
  });

  it("does not TRUNCATE it into the input", async () => {
    // The quiet half of the bug: `TextInput` cuts the value it is handed to
    // `maxLength`, so a fixed cap would show a shortened name and the next save
    // would store it — an edit to the credential's own field that nobody made.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue(LONG_NAME);
    expect(name.props.maxLength).toBeGreaterThanOrEqual(LONG_NAME.length);
  });

  it("posts the colour correction with the long name carried over intact", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const color = await screen.findByDisplayValue("Atigrada");
    fireEvent.changeText(color, "Blanca");
    fireEvent.press(screen.getByText("Guardar identidad"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      onlySection({ identity: { ...IDENTITY_AS_STORED, name: LONG_NAME, color: "Blanca" } }),
    );
  });

  it("still refuses a DIFFERENT over-long name, and does not post it", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue(LONG_NAME);
    fireEvent.changeText(name, `${LONG_NAME} y algo más`);
    fireEvent.press(screen.getByText("Guardar identidad"));
    expect(await screen.findByText(/demasiado largo/)).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("PetProfileEditScreen — the read failing", () => {
  it("says so and offers a retry rather than an empty form", async () => {
    // An empty form over a failed read is the worst outcome available: a person
    // would "correct" a blank name onto a real animal.
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/No pudimos conectarnos/)).toBeOnTheScreen();
    expect(screen.queryByText("Guardar identidad")).toBeNull();
    expect(screen.getByText("Reintentar")).toBeOnTheScreen();
  });
});
