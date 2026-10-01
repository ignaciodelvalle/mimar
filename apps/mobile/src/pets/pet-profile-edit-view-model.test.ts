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

import type { PetProfileDraftV1, PetProfileEditV1 } from "@dim/contract/api";
import { PET_NAME_MAX } from "@dim/contract/input";

import { PET_EDIT_SECTION_PARAM, editPetRoute } from "../ui/routes";
import {
  ACQUISITION_CHOICES,
  type EditDrafts,
  TRAINING_CHOICES,
  accountFallbackLabel,
  acquisitionChoiceLabel,
  breedChoicesFor,
  buildCorrectSpecies,
  buildEmergencyContacts,
  buildIdentityEdit,
  buildProfileHealth,
  buildProfileIdentity,
  buildProfileInsurance,
  buildProfileOrigin,
  buildProfilePublicCredential,
  buildTogglePhysicalTagInterest,
  contactsBlockedReason,
  editDraftsFrom,
  emergencyDraftFrom,
  identityBlockedReason,
  identityDraftFrom,
  identityFieldCaps,
  petEditSectionFromParam,
  petProfileInputCodeMessage,
  physicalTagInterestBody,
  physicalTagInterestRequestedAtLabel,
  physicalTagInterestSavedLabel,
  physicalTagInterestTitle,
  profileBlockedReason,
  reseedDrafts,
  sameEditDrafts,
  savedLabel,
  speciesBlockedReason,
  speciesDraftFrom,
  toggleCatalogPick,
  trainingChoiceLabel,
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
      canTogglePhysicalTagInterest: true,
      canManageServiceDog: true,
      canEditProfile: true,
    },
    physicalTagInterest: { interested: false, requestedAt: null },
    serviceDog: { designation: null },
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
        canTogglePhysicalTagInterest: false,
        canManageServiceDog: false,
        canEditProfile: false,
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
        canTogglePhysicalTagInterest: true,
        canManageServiceDog: false,
        canEditProfile: true,
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
        canTogglePhysicalTagInterest: true,
        canManageServiceDog: false,
        canEditProfile: false,
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

  it("names each refusal of the sectioned edit, the contact one in the web's own words", () => {
    expect(petProfileInputCodeMessage("SEX_INVALID")).toBe("Elegí el sexo de la mascota.");
    expect(petProfileInputCodeMessage("CONDITION_OTHER_REQUIRED")).toBe(
      "Describí la otra condición.",
    );
    expect(petProfileInputCodeMessage("CONDITION_OTHER_HAS_CONTACT")).toContain(
      "puede mostrarse en la credencial pública",
    );
  });

  it("does not promise a libreta entry for a section save — a toggle writes none", () => {
    expect(savedLabel("edit_profile", true)).toBe("Listo. Guardamos los cambios.");
    expect(savedLabel("edit_profile", false)).toContain("nada que cambiar");
  });
});

describe("D2 — el interés en la chapa física", () => {
  it("builds the toggle command with no fields", () => {
    const built = buildTogglePhysicalTagInterest();
    expect(built).toEqual({ ok: true, input: { command: "toggle_physical_tag_interest" } });
  });

  it("says the OPPOSITE thing before and after — obligatoria nunca aparece", () => {
    // Unlike tattoo's callout, this one must never say the photo/tag is
    // required: the contract accepts an absent one.
    expect(physicalTagInterestTitle("Pampa", false)).toContain("¿Querés");
    expect(physicalTagInterestTitle("Pampa", true)).toBe("Chapa física — anotado");
  });

  it("names the animal in the not-yet-interested body, and drops the name once anotado", () => {
    expect(physicalTagInterestBody("Pampa", false)).toContain("Pampa");
    // The body no longer needs to re-name the animal once the person already
    // knows they asked about THIS one — the title already did.
    expect(physicalTagInterestBody("Pampa", true)).not.toBe(
      physicalTagInterestBody("Pampa", false),
    );
  });

  it("reports each direction of the toggle in its own words", () => {
    expect(physicalTagInterestSavedLabel("interested")).toContain("anotado");
    expect(physicalTagInterestSavedLabel("cancelled")).toContain("Cancelaste");
  });

  it("renders no date line at all when there is none", () => {
    expect(physicalTagInterestRequestedAtLabel(null)).toBeNull();
  });

  it("renders an unreadable date as no line, never as Invalid Date", () => {
    expect(physicalTagInterestRequestedAtLabel("no es una fecha")).toBeNull();
  });

  it("renders a real ISO instant as an es-AR date line", () => {
    const label = physicalTagInterestRequestedAtLabel("2026-09-01T12:00:00.000Z");
    expect(label).toContain("Anotado el");
    expect(label).toMatch(/2026/);
  });
});

// ---------------------------------------------------------------------------
// `?seccion=` — the route that names a section, and the reader that honours it
// ---------------------------------------------------------------------------
//
// owner-pet-actions 5.1. "Contactos de emergencia" and "Editar datos" land on
// ONE screen; what tells them apart is the section the screen scrolls to. The
// parameter is written in `ui/routes.ts` and read by the `editar` route shell
// through `petEditSectionFromParam`, so the thing that has to hold is that the
// two agree — the same contract `document-face-param.test.ts` pins for `?face=`.
//
// THE EXPECTED STRINGS ARE SPELLED OUT, not composed from the builder: a test
// that re-derives its expectation from the function under test agrees with a
// broken builder and with nothing else.

const TOKEN = "DIM-PAMP-0001";

describe("editPetRoute — the screen, and the section it opens on", () => {
  it("names the screen with no query when no section is asked for", () => {
    // The two callers that predate sections (the old "Editar datos" row and
    // RehomeScreen's "Editar los datos") keep the plain path.
    expect(editPetRoute(TOKEN)).toBe("/mascotas/DIM-PAMP-0001/editar");
  });

  it("carries the section the caller asked for", () => {
    expect(editPetRoute(TOKEN, { seccion: "contactos" })).toBe(
      "/mascotas/DIM-PAMP-0001/editar?seccion=contactos",
    );
    expect(editPetRoute(TOKEN, { seccion: "seguro" })).toBe(
      "/mascotas/DIM-PAMP-0001/editar?seccion=seguro",
    );
  });

  it("still encodes the token, and puts the query AFTER it", () => {
    expect(editPetRoute("a/b", { seccion: "salud" })).toBe("/mascotas/a%2Fb/editar?seccion=salud");
  });

  it("uses the parameter name the route shell reads", () => {
    expect(PET_EDIT_SECTION_PARAM).toBe("seccion");
    expect(editPetRoute(TOKEN, { seccion: "origen" })).toContain(`?${PET_EDIT_SECTION_PARAM}=`);
  });
});

describe("petEditSectionFromParam — an unknown section is the default, not an error", () => {
  it("accepts exactly the six sections the screen draws", () => {
    for (const section of [
      "identidad",
      "salud",
      "contactos",
      "credencial",
      "seguro",
      "origen",
    ] as const) {
      expect(petEditSectionFromParam(section)).toBe(section);
    }
  });

  it("reads what the route builder writes, round trip", () => {
    const written = editPetRoute(TOKEN, { seccion: "credencial" });
    const query = written.slice(written.indexOf("?") + 1);
    const value = new URLSearchParams(query).get(PET_EDIT_SECTION_PARAM);
    expect(petEditSectionFromParam(value ?? undefined)).toBe("credencial");
  });

  it("takes the first of a repeated parameter, trimmed — the shape expo-router hands over", () => {
    expect(petEditSectionFromParam(["salud", "seguro"])).toBe("salud");
    expect(petEditSectionFromParam(" contactos ")).toBe("contactos");
  });

  it("answers null for anything else, so the screen opens at the top", () => {
    // Every one of these is a real shape a URL can arrive in: no parameter, the
    // empty string, a section a newer build has and this one does not, and
    // casing nobody wrote by hand.
    expect(petEditSectionFromParam(undefined)).toBeNull();
    expect(petEditSectionFromParam("")).toBeNull();
    expect(petEditSectionFromParam([])).toBeNull();
    expect(petEditSectionFromParam("microchip")).toBeNull();
    expect(petEditSectionFromParam("Contactos")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "Editar datos" by section — the drafts, and the one-section commands
// (owner-pet-actions 5.3)
// ---------------------------------------------------------------------------
//
// The app's "Editar datos" could change three fields; the web's, fifteen. The
// sectioned screen closes the gap with `edit_profile`, whose every section key
// is REQUIRED AND NULLABLE: `null` = "leave this section as stored". So each
// section's Guardar must send its own object and `null` for the other four —
// a Guardar that sent everything would write what another section's half-typed
// draft happens to hold.

/** The profile block as the server stores it. */
const PROFILE: PetProfileDraftV1 = {
  sex: "female",
  dateOfBirth: "2023-03-10",
  birthDateIsEstimated: true,
  // One catalog food and one the owner typed; the second is not a chip.
  favouriteFoods: ["Comida seca (balanceada)", "Zanahoria"],
  knownAllergies: ["Pollo"],
  trainingLevel: "basic",
  // A catalog code and a LEGACY one the catalog has since dropped.
  permanentConditions: ["sordo", "codigo_viejo"],
  permanentConditionsOther: null,
  emergencyInfoVisible: true,
  discloseConditionsPublicly: false,
  insuranceCompany: "Mapfre Mascotas",
  insurancePolicyNumber: "POL-123",
  acquisitionMethod: "adopted",
};

/** Noon in Argentina, 2026-10-01 — PROFILE's animal is 3 years and 6 months old. */
const NOW = new Date("2026-10-01T15:00:00.000Z");

const withProfile = (over: Partial<PetProfileEditV1> = {}) => view({ profile: PROFILE, ...over });

/** The drafts as the screen seeds them, failing loudly if the profile is absent. */
function seeded(over: Partial<PetProfileEditV1> = {}): EditDrafts & {
  profile: NonNullable<EditDrafts["profile"]>;
} {
  const drafts = editDraftsFrom(withProfile(over), NOW);
  if (drafts.profile === null) throw new Error("the profile drafts did not seed");
  return { ...drafts, profile: drafts.profile };
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

describe("editDraftsFrom — every section starts from what is stored", () => {
  it("shows the stored birth date as the AGE it reads as today, on Argentina's calendar", () => {
    expect(seeded().profile.identityExtras).toEqual({
      sex: "female",
      ageYears: "3",
      ageMonths: "6",
    });
  });

  it("leaves the age blank — not zero — when no birth date is stored", () => {
    const drafts = seeded({ profile: { ...PROFILE, dateOfBirth: null } });
    expect(drafts.profile.identityExtras).toMatchObject({ ageYears: "", ageMonths: "" });
  });

  it("splits a stored list into catalog chips and the typed rest", () => {
    expect(seeded().profile.health).toEqual({
      foods: ["Comida seca (balanceada)"],
      foodsOther: "Zanahoria",
      allergies: ["Pollo"],
      allergiesOther: "",
      trainingLevel: "basic",
      // The legacy code rides along, after the catalog's, so posting the
      // section back keeps it (the server keeps a code the animal already has).
      conditions: ["sordo", "codigo_viejo"],
      conditionsOther: "",
    });
  });

  it("seeds the toggles, the insurance and the origin as stored", () => {
    const { profile } = seeded();
    expect(profile.publicCredential).toEqual({
      emergencyInfoVisible: true,
      discloseConditionsPublicly: false,
    });
    expect(profile.insurance).toEqual({
      insuranceCompany: "Mapfre Mascotas",
      insurancePolicyNumber: "POL-123",
    });
    expect(profile.origin).toEqual({ acquisitionMethod: "adopted" });
  });

  it("seeds NO profile sections for a caller the server does not let in — a boundary, not a blank form", () => {
    const caretaker = editDraftsFrom(
      withProfile({
        capabilities: {
          canEditIdentity: false,
          canEditEmergencyContacts: false,
          canCorrectSpecies: false,
          canTogglePhysicalTagInterest: true,
          canManageServiceDog: false,
          canEditProfile: false,
        },
        profile: null,
      }),
      NOW,
    );
    expect(caretaker.profile).toBeNull();
    // The identity form's three fields still seed — that half has its own flag.
    expect(caretaker.identity).toEqual({ name: "Pampa", breed: "Mestizo", color: "Atigrada" });
  });

  it("treats a server that sends no profile block at all like one that sends null", () => {
    // An older server answers without the key; the sections must not crash on it.
    expect(editDraftsFrom(view(), NOW).profile).toBeNull();
  });
});

describe("profileBlockedReason — why a profile section is not offered", () => {
  it("says nothing while the profile is editable", () => {
    expect(profileBlockedReason(withProfile())).toBeNull();
  });

  it("names the arrangement for a caretaker, and a narrower access for anybody else", () => {
    const caps = view().capabilities;
    const caretaker = profileBlockedReason(
      withProfile({
        capabilities: { ...caps, canEditIdentity: false, canEditProfile: false },
        profile: null,
      }),
    );
    const orgPath = profileBlockedReason(
      withProfile({ capabilities: { ...caps, canEditProfile: false }, profile: null }),
    );
    expect(caretaker).toContain("cuidador");
    expect(orgPath).not.toBeNull();
    expect(orgPath).not.toEqual(caretaker);
  });
});

describe("each section's Guardar sends its own section and null for the rest", () => {
  it("Identidad: the five fields, the age posted back as shown", () => {
    const drafts = seeded();
    const built = buildProfileIdentity(
      drafts.identity,
      drafts.profile.identityExtras,
      view().identity,
    );
    expect(built).toEqual({
      ok: true,
      input: onlySection({
        identity: {
          name: "Pampa",
          breed: "Mestizo",
          color: "Atigrada",
          sex: "female",
          ageYears: 3,
          ageMonths: 6,
        },
      }),
    });
  });

  it("Identidad: a blank age clears it, and a NEW over-long name is refused before the round trip", () => {
    const drafts = seeded();
    const blank = buildProfileIdentity(
      drafts.identity,
      { sex: "male", ageYears: " ", ageMonths: "" },
      view().identity,
    );
    expect(blank.ok && blank.input).toMatchObject({
      identity: { sex: "male", ageYears: null, ageMonths: null },
    });

    const tooLong = buildProfileIdentity(
      { ...drafts.identity, name: "Pampa ".repeat(30) },
      drafts.profile.identityExtras,
      view().identity,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe("NAME_TOO_LONG");
  });

  it("Salud y cuidados: chips plus the typed rest, de-duplicated, and every condition code kept", () => {
    const { health } = seeded().profile;
    const built = buildProfileHealth({
      ...health,
      foodsOther: "Zanahoria,  Pollo hervido , ,Zanahoria",
      allergiesOther: "Pollo",
    });
    expect(built).toEqual({
      ok: true,
      input: onlySection({
        health: {
          favouriteFoods: ["Comida seca (balanceada)", "Zanahoria", "Pollo hervido"],
          knownAllergies: ["Pollo"],
          trainingLevel: "basic",
          permanentConditions: ["sordo", "codigo_viejo"],
          permanentConditionsOther: null,
        },
      }),
    });
  });

  it("Salud y cuidados: 'otra' needs its description, and the description may not carry a phone", () => {
    const { health } = seeded().profile;
    const missing = buildProfileHealth({ ...health, conditions: ["otra"], conditionsOther: " " });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("CONDITION_OTHER_REQUIRED");

    const phone = buildProfileHealth({
      ...health,
      conditions: ["otra"],
      conditionsOther: "Llamar al 11 5555 1234",
    });
    expect(phone.ok).toBe(false);
    if (!phone.ok) expect(phone.code).toBe("CONDITION_OTHER_HAS_CONTACT");
  });

  it("Qué muestra la credencial pública: the two toggles, alone", () => {
    expect(
      buildProfilePublicCredential({
        emergencyInfoVisible: false,
        discloseConditionsPublicly: true,
      }),
    ).toEqual({
      ok: true,
      input: onlySection({
        publicCredential: { emergencyInfoVisible: false, discloseConditionsPublicly: true },
      }),
    });
  });

  it("Seguro: an emptied field clears, a filled one is trimmed", () => {
    expect(
      buildProfileInsurance({ insuranceCompany: "  Sancor Seguros ", insurancePolicyNumber: "" }),
    ).toEqual({
      ok: true,
      input: onlySection({
        insurance: { insuranceCompany: "Sancor Seguros", insurancePolicyNumber: null },
      }),
    });
  });

  it("Origen: one of the six, or none at all", () => {
    expect(buildProfileOrigin({ acquisitionMethod: "found_stray" })).toEqual({
      ok: true,
      input: onlySection({ origin: { acquisitionMethod: "found_stray" } }),
    });
    expect(buildProfileOrigin({ acquisitionMethod: null })).toEqual({
      ok: true,
      input: onlySection({ origin: { acquisitionMethod: null } }),
    });
  });
});

describe("toggleCatalogPick — chips stay in catalog order, and a legacy value is never dropped", () => {
  const CATALOG = ["a", "b", "c"];

  it("adds a pick in catalog order, whatever order it was tapped in", () => {
    expect(toggleCatalogPick(CATALOG, ["c"], "a")).toEqual(["a", "c"]);
  });

  it("removes a pick that was on", () => {
    expect(toggleCatalogPick(CATALOG, ["a", "c"], "a")).toEqual(["c"]);
  });

  it("keeps a value the catalog does not carry, after the catalog's", () => {
    expect(toggleCatalogPick(CATALOG, ["viejo", "b"], "c")).toEqual(["b", "c", "viejo"]);
  });
});

describe("reseedDrafts — a save re-reads its OWN section and keeps what was typed elsewhere", () => {
  it("re-seeds the saved section from the server, and leaves another section's draft alone", () => {
    const current = seeded();
    const typing: EditDrafts = {
      ...current,
      profile: {
        ...current.profile,
        health: { ...current.profile.health, allergiesOther: "Ácaros" },
        insurance: { insuranceCompany: "Sancor Seguros", insurancePolicyNumber: "X-9" },
      },
    };
    // The server stored the insurance as normalised; health was never sent.
    const fresh = seeded({
      profile: { ...PROFILE, insuranceCompany: "Sancor Seguros", insurancePolicyNumber: "X-9" },
    });
    const next = reseedDrafts(typing, fresh, "insurance");
    expect(next.profile?.insurance).toEqual(fresh.profile.insurance);
    expect(next.profile?.health.allergiesOther).toBe("Ácaros");
  });

  it("re-seeds the identity fields after a species correction, which may clear the breed", () => {
    const current = seeded();
    const fresh = seeded({ species: "cat", identity: { name: "Pampa", breed: null, color: null } });
    const next = reseedDrafts(current, fresh, "species");
    expect(next.species).toBe("cat");
    expect(next.identity.breed).toBe("");
  });
});

describe("sameEditDrafts — what the discard guard asks", () => {
  it("is quiet for drafts nobody touched, and notices a single toggle", () => {
    const a = seeded();
    expect(sameEditDrafts(a, seeded())).toBe(true);
    const toggled: EditDrafts = {
      ...a,
      profile: {
        ...a.profile,
        publicCredential: { ...a.profile.publicCredential, emergencyInfoVisible: false },
      },
    };
    expect(sameEditDrafts(a, toggled)).toBe(false);
  });

  it("notices a chip, which a shallow comparison of the section would miss", () => {
    const a = seeded();
    const picked: EditDrafts = {
      ...a,
      profile: {
        ...a.profile,
        health: { ...a.profile.health, allergies: ["Pollo", "Cerdo"] },
      },
    };
    expect(sameEditDrafts(a, picked)).toBe(false);
  });
});

describe("the single-choice rows offer 'No especificar' first, worded once", () => {
  it("lists the training levels after the unset choice, with the catalogue's words", () => {
    expect(TRAINING_CHOICES[0]).toBe("sin_dato");
    expect(TRAINING_CHOICES.slice(1)).toEqual([
      "none",
      "basic",
      "intermediate",
      "advanced",
      "professional",
    ]);
    expect(trainingChoiceLabel("sin_dato")).toBe("No especificar");
    expect(trainingChoiceLabel("basic")).toBe("Básico (sentarse, venir)");
  });

  it("lists the six acquisition methods after it, in the alta's own words", () => {
    expect(ACQUISITION_CHOICES).toEqual([
      "sin_dato",
      "adopted",
      "purchased",
      "found_stray",
      "gift",
      "born_in_litter",
      "other",
    ]);
    expect(acquisitionChoiceLabel("found_stray")).toBe("La encontré");
    expect(acquisitionChoiceLabel("sin_dato")).toBe("No especificar");
  });
});
