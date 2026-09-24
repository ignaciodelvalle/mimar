// `PetProfileEditScreen` — the render tests for the first native screen that
// CORRECTS something the app already recorded.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE TWO HALVES ARE GATED SEPARATELY, from `capabilities` and never from
//      "this pet is mine". The case that matters is the FOSTER: allowed to
//      correct the animal's name, not allowed anywhere near the titular's own
//      vet and phone. A screen that reasoned from one flag gets exactly this
//      person wrong.
//   2. NO CONTROL IS OFFERED THAT CAN ONLY BE REFUSED. Where a flag is false the
//      screen renders the REASON, not a disabled form and not a form whose save
//      answers 403.
//   3. THE FORM IS RE-SEEDED FROM THE SERVER AFTER A SAVE, so a value the server
//      normalised (a breed folded to its canonical label) is what the field ends
//      up showing — not what the person typed.
//   4. "NOTHING CHANGED" IS SAID OUT LOUD rather than dressed as success.
//   5. THE STORED BREED IS REACHABLE even when the catalog has lost it (QA A5).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

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

import type { PetProfileEditV1 } from "@dim/contract/api";

import { PetProfileEditScreen } from "./PetProfileEditScreen";

const TOKEN = "DIM-PAMP-0001";

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
    capabilities: {
      canEditIdentity: true,
      canEditEmergencyContacts: true,
      canCorrectSpecies: true,
    },
    ...over,
  } as PetProfileEditV1;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockSend.mockResolvedValue({
    outcome: "ok",
    payload: { command: "edit_identity", changed: true },
  });
});

describe("PetProfileEditScreen — the two halves are gated separately", () => {
  it("pre-fills both forms from the server's own values", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByDisplayValue("Pampa")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("Atigrada")).toBeOnTheScreen();
    expect(screen.getByDisplayValue("Vet Norte")).toBeOnTheScreen();
  });

  it("gives a FOSTER the identity form and refuses the contacts, with the reason", async () => {
    // THE CASE A SINGLE FLAG GETS WRONG. A foster is a Path-1 holder: they may
    // correct the animal's name (requireTitularAccess admits them) and must not
    // see the legal owner's vet and phone (the writer's join says role='owner').
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          canEditIdentity: true,
          canEditEmergencyContacts: false,
          canCorrectSpecies: true,
        },
        emergencyContacts: null,
        emergencyAccountDefault: null,
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByDisplayValue("Pampa")).toBeOnTheScreen();
    // The form that IS theirs is live…
    expect(screen.getByText("Guardar datos")).toBeOnTheScreen();
    // …and the one that is not shows a sentence instead of a control.
    expect(screen.queryByText("Guardar contactos")).toBeNull();
    expect(screen.getByText(/Solo esa persona puede cambiarlos/)).toBeOnTheScreen();
  });

  it("refuses the identity form on its own flag, with a different sentence", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          canEditIdentity: false,
          canEditEmergencyContacts: true,
          canCorrectSpecies: false,
        },
      }),
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/solo del titular/)).toBeOnTheScreen();
    expect(screen.queryByText("Guardar datos")).toBeNull();
    // The other half is untouched by that refusal.
    expect(screen.getByText("Guardar contactos")).toBeOnTheScreen();
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
    // Two save groups, one question: somebody may have saved the identity and
    // still be holding an unsaved phone number, and a guard that watched only
    // the first would let that one go.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByDisplayValue("Vet Norte"), "Vet Sur");
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
    fireEvent.press(screen.getByText("Guardar datos"));
    // WAIT ON THE RE-READ, not on the field: the input already shows "Pampita"
    // from the local edit, so `findByDisplayValue` resolves before the save has
    // even been sent and the assertion below would read a draft that is
    // genuinely still dirty.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("PetProfileEditScreen — saving", () => {
  it("posts the identity command with the fields as typed", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue("Pampa");
    fireEvent.changeText(name, "Pampita");
    fireEvent.press(screen.getByText("Guardar datos"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "edit_identity",
      name: "Pampita",
      breed: "Mestizo",
      color: "Atigrada",
    });
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
    fireEvent.press(screen.getByText("Guardar datos"));
    expect(await screen.findByDisplayValue("Pampita")).toBeOnTheScreen();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("says nothing needed saving when the server reports no change", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "edit_identity", changed: false },
    });
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");
    fireEvent.press(screen.getByText("Guardar datos"));
    expect(await screen.findByText(/nada que cambiar/)).toBeOnTheScreen();
  });

  it("refuses an empty name locally, and does not post it", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue("Pampa");
    fireEvent.changeText(name, "   ");
    fireEvent.press(screen.getByText("Guardar datos"));
    expect(await screen.findByText(/El nombre no puede quedar vacío/)).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("posts the species correction as its OWN command, never as a field of the identity edit", async () => {
    // FULL-LOCK (PO decision #40): `edit_identity` refuses the species, so the
    // card has its own chips and its own button, and what leaves the phone is
    // `correct_species` and nothing else.
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
        },
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
    fireEvent.press(screen.getByText("Guardar datos"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "edit_identity",
      name: "Pampa",
      breed: "Ovejero Inventado",
      color: null,
    });
  });
});

describe("PetProfileEditScreen — the breed picker does not dump the catalog (B-01)", () => {
  it("shows only the stored breed until somebody types, then the matches", async () => {
    // MEASURED on the shipped build 10 (shot 102): opening "Editar datos" drew
    // twelve breeds inline under the filter box and pushed COLOR and "Guardar
    // datos" a full screen down. The list is an ANSWER to a query; with no
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

  it("names itself after its visible label, not 'Buscar raza' (WCAG 2.5.3)", async () => {
    // The same defect lote 1a fixed on LocalityPicker: a voice user reading
    // "Raza" off the screen and saying it named nothing at all.
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    await screen.findByDisplayValue("Pampa");

    expect(screen.getByLabelText("Raza")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Buscar raza")).toBeNull();
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
    fireEvent.press(screen.getByText("Guardar datos"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "edit_identity",
      name: LONG_NAME,
      breed: "Mestizo",
      color: "Blanca",
    });
  });

  it("still refuses a DIFFERENT over-long name, and does not post it", async () => {
    render(<PetProfileEditScreen publicToken={TOKEN} />);
    const name = await screen.findByDisplayValue(LONG_NAME);
    fireEvent.changeText(name, `${LONG_NAME} y algo más`);
    fireEvent.press(screen.getByText("Guardar datos"));
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
    expect(screen.queryByText("Guardar datos")).toBeNull();
    expect(screen.getByText("Reintentar")).toBeOnTheScreen();
  });
});
