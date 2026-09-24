// The pure half of Editar: what a person reads, and what a draft becomes.
//
// WHAT THIS FILE HAS TO PROVE
//   1. THE TWO CAPABILITIES ARE READ, NEVER DERIVED. Each half of the screen is
//      blocked by its own flag, with its own sentence, and the sentences differ
//      because the two refusals are different facts about the reader.
//   2. THE GRANDFATHERED BREED SURVIVES. A stored value the catalog does not
//      carry is offered FIRST; that is the QA A5 rule reaching the picker.
//   3. AN EMPTY FIELD CLEARS, and a cleared field is described honestly —
//      including when the account default is empty too.
//   4. A NO-OP SAVE IS REPORTED AS ONE.
//   5. THE LENGTH CAPS ARE GRANDFATHERED, in both directions. An animal whose
//      stored name is longer than the cap must still be editable — the input
//      must not TRUNCATE it on screen, and the save must not refuse it on the
//      way back. Both halves come from the payload the screen already holds.

import { describe, expect, it } from "@jest/globals";

import type { PetProfileEditV1 } from "@dim/contract/api";
import { PET_NAME_MAX } from "@dim/contract/input";

import {
  accountFallbackLabel,
  breedChoicesFor,
  buildCorrectSpecies,
  buildEmergencyContacts,
  buildIdentityEdit,
  contactsBlockedReason,
  emergencyDraftFrom,
  identityBlockedReason,
  identityDraftFrom,
  identityFieldCaps,
  petProfileInputCodeMessage,
  savedLabel,
  speciesBlockedReason,
  speciesDraftFrom,
} from "./pet-profile-edit-view-model";

function view(over: Partial<PetProfileEditV1> = {}): PetProfileEditV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-29T10:00:00.000Z",
    staleAfter: "2026-08-29T10:01:00.000Z",
    publicToken: "DIM-PAMP-0001",
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

describe("the drafts start from the server", () => {
  it("turns a null breed and colour into empty inputs, not into the word null", () => {
    const draft = identityDraftFrom(
      view({ identity: { name: "Pampa", breed: null, color: null } }),
    );
    expect(draft).toEqual({ name: "Pampa", breed: "", color: "" });
  });

  it("hands back null — not four blank fields — when the caller may not read the contacts", () => {
    // A blank form is an invitation to save something that can only be refused.
    expect(emergencyDraftFrom(view({ emergencyContacts: null }))).toBeNull();
  });
});

describe("the two capabilities are two different refusals", () => {
  it("says nothing at all while both are allowed", () => {
    expect(identityBlockedReason(view())).toBeNull();
    expect(contactsBlockedReason(view())).toBeNull();
  });

  it("names the ARRANGEMENT for identity and the PERSON for the contacts", () => {
    const blocked = view({
      capabilities: {
        canEditIdentity: false,
        canEditEmergencyContacts: false,
        canCorrectSpecies: false,
      },
    });
    const identity = identityBlockedReason(blocked);
    const contacts = contactsBlockedReason(blocked);
    expect(identity).toContain("cuidador");
    expect(contacts).toContain("dueño");
    // NOT the same sentence: a co-owner reaches the second and not the first,
    // and telling them they are a caretaker would be false.
    expect(identity).not.toEqual(contacts);
  });

  it("blocks the contacts alone for a holder who is not the legal owner", () => {
    const foster = view({
      capabilities: {
        canEditIdentity: true,
        canEditEmergencyContacts: false,
        canCorrectSpecies: true,
      },
      emergencyContacts: null,
      emergencyAccountDefault: null,
    });
    expect(identityBlockedReason(foster)).toBeNull();
    expect(contactsBlockedReason(foster)).not.toBeNull();
  });

  it("blocks the species correction from its OWN flag, naming the act", () => {
    // MUTATION APPLIED: read `canEditIdentity` instead of `canCorrectSpecies`.
    // Red — the day the web narrows the correction the identity form would go
    // on offering a control the server refuses.
    const caretaker = view({
      capabilities: {
        canEditIdentity: true,
        canEditEmergencyContacts: false,
        canCorrectSpecies: false,
      },
    });
    expect(speciesBlockedReason(view())).toBeNull();
    expect(speciesBlockedReason(caretaker)).toContain("especie");
  });
});

describe("the species chips start on the animal's own", () => {
  it("selects the stored species when this build knows it", () => {
    expect(speciesDraftFrom(view({ species: "cat" }))).toBe("cat");
  });

  it("selects nothing for a species the contract does not list — never a wrong chip", () => {
    expect(speciesDraftFrom(view({ species: "chinchilla" }))).toBeNull();
  });

  it("posts the chosen species as the correction command", () => {
    const built = buildCorrectSpecies("cat");
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.input).toEqual({ command: "correct_species", species: "cat" });
  });

  it("refuses to post with no chip chosen, with the web form's own sentence", () => {
    const built = buildCorrectSpecies(null);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("SPECIES_INVALID");
      expect(built.message).toBe("Elegí una especie válida.");
    }
  });
});

describe("the breed picker keeps what the catalog has forgotten", () => {
  it("offers a stored off-catalog breed FIRST, so an unrelated edit cannot wipe it", () => {
    const options = breedChoicesFor("dog", "Ovejero Patagónico Inventado");
    expect(options[0]).toBe("Ovejero Patagónico Inventado");
    expect(options.length).toBeGreaterThan(1);
  });

  it("does not duplicate a stored breed the catalog already carries", () => {
    const options = breedChoicesFor("dog", "Mestizo / Cruza");
    const catalog = breedChoicesFor("dog", null);
    // Either it was in the catalog (same list) or it was appended (one longer).
    expect(options.length - catalog.length).toBeLessThanOrEqual(1);
    if (catalog.includes("Mestizo / Cruza")) expect(options).toEqual(catalog);
  });

  it("treats a blank stored breed as no stored breed", () => {
    expect(breedChoicesFor("dog", "   ")).toEqual(breedChoicesFor("dog", null));
  });
});

describe("what clearing a field will actually show", () => {
  it("names the account default when there is one", () => {
    expect(accountFallbackLabel(view(), "emergency")).toContain("Mamá");
    expect(accountFallbackLabel(view(), "emergency")).toContain("1199887766");
  });

  it("says plainly that nothing will show when the account has nothing either", () => {
    // The failure this prevents: a form that promises a fallback that does not
    // exist, and an owner who clears their vet believing one is behind it.
    expect(accountFallbackLabel(view(), "vet")).toContain("tampoco");
  });

  it("says nothing at all when the caller may not see the defaults", () => {
    expect(accountFallbackLabel(view({ emergencyAccountDefault: null }), "vet")).toBe("");
  });
});

const STORED = { name: "Pampa", color: "Atigrada" };

/** Longer than any cap — the shape a legacy `pets.name` can already hold. */
const LONG_NAME = "Pampa ".repeat(30).trim();

describe("drafts become commands the contract accepts", () => {
  it("sends an empty breed and colour as null — an empty box means empty", () => {
    const built = buildIdentityEdit({ name: "Pampa", breed: "   ", color: "" }, STORED);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).toEqual({
        command: "edit_identity",
        name: "Pampa",
        breed: null,
        color: null,
      });
    }
  });

  it("refuses an empty name locally, with the field's own sentence", () => {
    const built = buildIdentityEdit({ name: "   ", breed: "", color: "" }, STORED);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("NAME_REQUIRED");
      expect(built.message).toContain("nombre");
    }
  });

  it("refuses a NEW name past the cap rather than posting it", () => {
    const built = buildIdentityEdit({ name: LONG_NAME, breed: "", color: "" }, STORED);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("NAME_TOO_LONG");
  });

  it("lets the owner of an over-long name correct the COLOUR", () => {
    // THE LOCKOUT this exists to prevent. `edit_identity` posts all three fields
    // on every save, so a cap applied to the carried-over name would refuse a
    // request that only wants to change the colour — and that owner could never
    // edit anything on this screen again, from the one device they have.
    const built = buildIdentityEdit(
      { name: LONG_NAME, breed: "", color: "Blanca" },
      { name: LONG_NAME, color: "Atigrada" },
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.input).toMatchObject({ name: LONG_NAME, color: "Blanca" });
  });

  it("still refuses a DIFFERENT over-long name on that same animal", () => {
    // The grandfather is for the value on the row, not a licence to type any
    // length once one long value exists.
    const built = buildIdentityEdit(
      { name: `${LONG_NAME} y algo más`, breed: "", color: "" },
      { name: LONG_NAME, color: null },
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("NAME_TOO_LONG");
  });

  it("refuses a NEW over-long colour with the colour's code, not the name's", () => {
    const built = buildIdentityEdit(
      { name: "Pampa", breed: "", color: "atigrada con manchas ".repeat(20) },
      STORED,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("COLOR_TOO_LONG");
  });

  it("sends all four contact fields every time, so an empty one clears", () => {
    const built = buildEmergencyContacts({
      preferredVetName: "Vet Sur",
      preferredVetPhone: "",
      emergencyContactName: "",
      emergencyContactPhone: "",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).toEqual({
        command: "set_emergency_contacts",
        preferredVetName: "Vet Sur",
        preferredVetPhone: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
      });
    }
  });

  it("refuses an over-long phone with the phone's cap, not the name's", () => {
    const built = buildEmergencyContacts({
      preferredVetName: "",
      preferredVetPhone: "9".repeat(60),
      emergencyContactName: "",
      emergencyContactPhone: "",
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("CONTACT_PHONE_TOO_LONG");
  });
});

describe("the input caps cannot shorten what is already stored", () => {
  it("uses the contract's constant for an ordinary name", () => {
    expect(identityFieldCaps(view()).name).toBe(PET_NAME_MAX);
  });

  it("rises to the stored length when the animal already carries a longer one", () => {
    // A `TextInput` TRUNCATES the value it is handed. A fixed cap here would put
    // a shortened name on screen and the next "Guardar datos" would store it —
    // an unrequested edit to the field the credential is read by, which is worse
    // than the refusal, because nobody would see it happen.
    const caps = identityFieldCaps(
      view({ identity: { name: LONG_NAME, breed: null, color: null } }),
    );
    expect(caps.name).toBe(LONG_NAME.length);
  });

  it("does the same for the colour, and the two do not borrow each other's cap", () => {
    const longColor = "atigrada con manchas ".repeat(20).trim();
    const caps = identityFieldCaps(
      view({ identity: { name: "Pampa", breed: null, color: longColor } }),
    );
    expect(caps.color).toBe(longColor.length);
    expect(caps.name).toBe(PET_NAME_MAX);
  });
});

describe("every input code has a sentence, and a no-op is not a lie", () => {
  it("says something honest when the contract names no code at all", () => {
    expect(petProfileInputCodeMessage(null)).toContain("no pudo interpretar");
  });

  it("tells a person nothing needed saving instead of congratulating them", () => {
    expect(savedLabel("edit_identity", false)).toContain("nada que cambiar");
    expect(savedLabel("set_emergency_contacts", false)).toContain("nada que cambiar");
  });

  it("says where a real identity change went — the libreta, not nowhere", () => {
    expect(savedLabel("edit_identity", true)).toContain("libreta");
  });

  it("reports a species correction the way the web does — recorded, or nothing to correct", () => {
    expect(savedLabel("correct_species", true)).toContain("libreta");
    expect(savedLabel("correct_species", false)).toBe(
      "La especie es la misma; no hay nada que corregir.",
    );
  });
});
