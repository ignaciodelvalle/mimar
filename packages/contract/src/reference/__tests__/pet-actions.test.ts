// `derivePetActions` — the one answer both owner panels render from.
//
// The web's "⋯ Más" sheet, the app's "Más" list and the Anotar catalogue's
// "Perfil" category each kept their own labels, order and gates, and the three
// had drifted apart (a co-owner read a live row the web refused, a deceased
// animal offered pages the web hid). These tests pin the merged rules once, as
// behaviour: who sees a row, who sees it grey and why, and when a row is gone.
//
// Every scenario names the viewer, the animal's situation and the species,
// because those three are the whole input — a test that varies one of them and
// leaves the others implicit proves less than it reads.

import { describe, expect, it } from "vitest";

import {
  type DerivedPetActions,
  PET_ACTION_IDS,
  PET_ACTION_INERT_CAPTIONS,
  type PetActionContext,
  type PetActionId,
  derivePetActions,
  findPetAction,
} from "../pet-actions.ts";

const OWNER_ACTIVE_DOG: PetActionContext = {
  viewerRole: "owner",
  isTitular: true,
  petStatus: "active",
  species: "dog",
  pppDoor: false,
};

function ids(derived: DerivedPetActions): {
  primary: PetActionId[];
  groups: Array<[string, PetActionId[]]>;
} {
  return {
    primary: derived.primary.map((a) => a.id),
    groups: derived.groups.map((g) => [g.id, g.actions.map((a) => a.id)]),
  };
}

function stateOf(derived: DerivedPetActions, id: PetActionId): string {
  const action = findPetAction(derived, id);
  if (action === null) return "absent";
  return action.state.kind === "live" ? "live" : `inert:${action.state.reason}`;
}

describe("derivePetActions — the titular of a healthy dog sees every door open", () => {
  const derived = derivePetActions(OWNER_ACTIVE_DOG);

  it("puts Anotar, Compartir and Modo perdida in the primary row, in that order", () => {
    expect(derived.primary.map((a) => a.label)).toEqual(["Anotar", "Compartir", "Modo perdida"]);
  });

  it("groups the rest under the four themes plus the closing act, in the panel's order", () => {
    expect(ids(derived).groups).toEqual([
      ["pet", ["edit", "photo", "contacts", "service_dog", "physical_tag"]],
      ["health", ["vaccine_reminders"]],
      ["trips", ["travel"]],
      ["custody", ["caretaker", "return", "find_home", "transfer"]],
      ["closing", ["death"]],
    ]);
    expect(derived.groups.map((g) => g.heading)).toEqual([
      "La mascota",
      "Salud",
      "Viajes",
      "Custodia",
      null,
    ]);
  });

  it("offers every row live", () => {
    for (const id of PET_ACTION_IDS) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("captions the death row with what it does, even while live", () => {
    expect(findPetAction(derived, "death")?.caption).toBe("Cierra el registro del animal");
    expect(findPetAction(derived, "edit")?.caption).toBeNull();
  });

  it("names the titular's rehoming row by what the titular asks for", () => {
    expect(findPetAction(derived, "find_home")?.label).toBe("Acompañamiento de adopción");
  });
});

describe("derivePetActions — a deceased animal keeps four doors and nothing else", () => {
  it("drops every write except Compartir, Editar datos, Foto and Contactos", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: "deceased" });
    expect(ids(derived)).toEqual({
      primary: ["share"],
      groups: [["pet", ["edit", "photo", "contacts"]]],
    });
  });

  it("keeps each of the four under its own rule — a caretaker still cannot edit", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "caretaker",
      isTitular: false,
      petStatus: "deceased",
    });
    expect(stateOf(derived, "edit")).toBe("inert:caretaker");
    expect(stateOf(derived, "photo")).toBe("live");
    expect(stateOf(derived, "contacts")).toBe("inert:titular_only");
  });
});

describe("derivePetActions — what does not apply is shown grey, with the reason", () => {
  it("a co-owner sees the titular-only rows inert, captioned 'Solo el titular'", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "co_owner",
      isTitular: false,
    });
    for (const id of ["contacts", "service_dog", "caretaker", "transfer", "find_home"] as const) {
      expect(stateOf(derived, id), id).toBe("inert:titular_only");
      expect(findPetAction(derived, id)?.caption, id).toBe("Solo el titular");
    }
    // Everything a co-owner may do stays live.
    for (const id of ["record", "lost", "edit", "photo", "travel", "return", "death"] as const) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("a titular with a LOST animal cannot transfer it or lend it, and is told why", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: "lost" });
    expect(stateOf(derived, "transfer")).toBe("inert:not_active");
    expect(stateOf(derived, "caretaker")).toBe("inert:not_active");
    expect(findPetAction(derived, "transfer")?.caption).toBe("No se puede en esta situación");
    // Lost mode is the cockpit for both directions: it stays on a lost animal.
    expect(stateOf(derived, "lost")).toBe("live");
    expect(stateOf(derived, "find_home")).toBe("live");
  });

  it("a caretaker keeps the acts the role exists for and sees the owner's rows grey", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "caretaker",
      isTitular: false,
    });
    expect(stateOf(derived, "edit")).toBe("inert:caretaker");
    expect(stateOf(derived, "travel")).toBe("inert:caretaker");
    expect(stateOf(derived, "contacts")).toBe("inert:titular_only");
    expect(findPetAction(derived, "edit")?.caption).toBe(PET_ACTION_INERT_CAPTIONS.caretaker);
    for (const id of [
      "record",
      "share",
      "lost",
      "photo",
      "physical_tag",
      "return",
      "death",
    ] as const) {
      expect(stateOf(derived, id), id).toBe("live");
    }
  });

  it("a foster gets the rehoming row under the foster's own name, live", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "foster",
      isTitular: false,
    });
    const findHome = findPetAction(derived, "find_home");
    expect(findHome?.label).toBe("Buscar hogar");
    expect(findHome?.state).toEqual({ kind: "live" });
    expect(stateOf(derived, "travel")).toBe("live");
    expect(stateOf(derived, "transfer")).toBe("inert:titular_only");
  });
});

describe("derivePetActions — rows that are not this viewer's world are absent", () => {
  it("an organization member gets Compartir and no panel at all", () => {
    const derived = derivePetActions({
      ...OWNER_ACTIVE_DOG,
      viewerRole: "org_member",
      isTitular: false,
    });
    expect(ids(derived)).toEqual({ primary: ["share"], groups: [] });
  });

  it("the assistance-dog row exists for dogs only", () => {
    const cat = derivePetActions({ ...OWNER_ACTIVE_DOG, species: "cat" });
    expect(stateOf(cat, "service_dog")).toBe("absent");
    expect(cat.groups[0]?.actions.map((a) => a.id)).toEqual([
      "edit",
      "photo",
      "contacts",
      "physical_tag",
    ]);
  });
});

describe("derivePetActions — a section that did not load takes nothing away", () => {
  it("an unread status reads as no fact, so the titular rows stay live", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, petStatus: null });
    expect(stateOf(derived, "transfer")).toBe("live");
    expect(stateOf(derived, "record")).toBe("live");
  });

  it("an unread species keeps the assistance-dog row offered", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, species: null });
    expect(stateOf(derived, "service_dog")).toBe("live");
  });
});

describe("derivePetActions — the attestation door is the compliance card's, not a row", () => {
  it("opens only when the regime is KNOWN to apply and the animal is alive", () => {
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true }).attestationDoor).toBe(true);
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: false }).attestationDoor).toBe(false);
    // The one place an unread fact CLOSES a door: offering the dangerous-breed
    // form on an outage would put it in front of almost every owner.
    expect(derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: null }).attestationDoor).toBe(false);
    expect(
      derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true, petStatus: "deceased" })
        .attestationDoor,
    ).toBe(false);
  });

  it("never appears as a panel row", () => {
    const derived = derivePetActions({ ...OWNER_ACTIVE_DOG, pppDoor: true });
    const everyLabel = [...derived.primary, ...derived.groups.flatMap((g) => g.actions)].map(
      (a) => a.label,
    );
    expect(everyLabel.some((label) => /atestaci/i.test(label))).toBe(false);
  });
});

describe("the catalogue itself", () => {
  it("places every action id exactly once across the primary row and the groups", () => {
    const placed = ids(derivePetActions(OWNER_ACTIVE_DOG));
    const all = [...placed.primary, ...placed.groups.flatMap(([, actions]) => actions)];
    expect([...all].sort()).toEqual([...PET_ACTION_IDS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives every action a hint a screen reader can say", () => {
    const derived = derivePetActions(OWNER_ACTIVE_DOG);
    for (const action of [...derived.primary, ...derived.groups.flatMap((g) => g.actions)]) {
      expect(action.hint.length, action.id).toBeGreaterThan(10);
    }
  });
});
