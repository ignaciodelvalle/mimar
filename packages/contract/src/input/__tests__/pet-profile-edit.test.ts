// `petProfileCommandInputSchema` and the length gate beside it — what a client
// may send to `POST .../profile`, and how long the two free-text identity
// fields may be.
//
// THE ONE CASE A REVIEWER SHOULD READ FIRST is the grandfather block. The caps
// on `name` and `color` are NOT on the schema, and that is the whole point:
// `pets.name` and `pets.color` are unbounded `text` whose only writer caps
// neither, so values longer than `PET_NAME_MAX` already exist in the database.
// A cap that could not see the stored row would apply itself to those values on
// the way back out and refuse the entire request — including the COLOUR
// correction the person actually came to make, because `edit_identity` carries
// all three fields on every save. The owner ends up locked out of their own
// record by a number invented after their data.
//
// So the rule is the one QA A5 already established one field over: only NEW
// values are gated, and a value identical to the one on the animal passes at any
// length. These tests are what fails if somebody "tidies" the gate back onto the
// schema, where the stored value is not in scope.

import { describe, expect, it } from "vitest";

import {
  PET_ALLERGIES_MAX,
  PET_ALLERGY_ENTRY_MAX,
  PET_COLOR_MAX,
  PET_CONDITION_OTHER_MAX,
  PET_FOODS_MAX,
  PET_FOOD_ENTRY_MAX,
  PET_INSURANCE_COMPANY_MAX,
  PET_INSURANCE_POLICY_MAX,
  PET_NAME_MAX,
  PET_PROFILE_TEXT_LENGTH_CODES,
  PET_PROFILE_TEXT_LENGTH_MESSAGES,
  firstPetProfileCommandInputCode,
  petIdentityFieldCap,
  petProfileCommandInputSchema,
  resolvePetIdentityLengths,
  resolvePetProfileTextLengths,
} from "../pet-profile-edit.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = petProfileCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstPetProfileCommandInputCode(parsed.error);
}

/** A name far past any cap — the shape a legacy row can already hold. */
const LONG_NAME = "Pampa ".repeat(30).trim();
const LONG_COLOR = "atigrada con manchas ".repeat(20).trim();

const STORED = { name: "Pampa", color: "Atigrada" };

describe("edit_identity — the schema itself", () => {
  it("accepts the three fields and clears breed and colour with null", () => {
    const parsed = petProfileCommandInputSchema.safeParse({
      command: "edit_identity",
      name: "  Pampita  ",
      breed: null,
      color: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        command: "edit_identity",
        name: "Pampita",
        breed: null,
        color: null,
      });
    }
  });

  it("still refuses a blank name — the column is not null and the credential is read by it", () => {
    expect(codeFor({ command: "edit_identity", name: "   ", breed: null, color: null })).toBe(
      "NAME_REQUIRED",
    );
  });

  it("does NOT refuse a long name, because it cannot see the animal", () => {
    // The distinction the schema is structurally unable to make: this body is
    // either a legacy value being carried over or a new one being typed, and
    // only the stored row says which. Refusing here would refuse both.
    expect(
      codeFor({ command: "edit_identity", name: LONG_NAME, breed: null, color: LONG_COLOR }),
    ).toBeNull();
  });

  it("keeps the two contact caps, which mirror the server's own numbers", () => {
    expect(
      codeFor({
        command: "set_emergency_contacts",
        preferredVetName: "x".repeat(81),
        preferredVetPhone: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
      }),
    ).toBe("CONTACT_NAME_TOO_LONG");
    expect(
      codeFor({
        command: "set_emergency_contacts",
        preferredVetName: "",
        preferredVetPhone: "9".repeat(41),
        emergencyContactName: "",
        emergencyContactPhone: "",
      }),
    ).toBe("CONTACT_PHONE_TOO_LONG");
  });
});

describe("resolvePetIdentityLengths — only NEW values are capped", () => {
  it("admits a value inside the cap", () => {
    expect(resolvePetIdentityLengths({ name: "Pampita", color: "Blanca" }, STORED)).toEqual({
      ok: true,
    });
  });

  it("refuses a NEW name past the cap", () => {
    expect(resolvePetIdentityLengths({ name: LONG_NAME, color: null }, STORED)).toEqual({
      ok: false,
      code: "NAME_TOO_LONG",
    });
  });

  it("refuses a NEW colour past the cap, naming the colour and not the name", () => {
    expect(resolvePetIdentityLengths({ name: "Pampa", color: LONG_COLOR }, STORED)).toEqual({
      ok: false,
      code: "COLOR_TOO_LONG",
    });
  });

  it("ADMITS the animal's own over-long name, posted back unchanged", () => {
    // The lockout this exists to prevent. Without it the owner of a pet recorded
    // with a 180-character name could not correct anything on this screen ever
    // again — the form posts the name on every save.
    expect(
      resolvePetIdentityLengths(
        { name: LONG_NAME, color: "Blanca" },
        { name: LONG_NAME, color: "Atigrada" },
      ),
    ).toEqual({ ok: true });
  });

  it("ADMITS the animal's own over-long colour while the name is being corrected", () => {
    expect(
      resolvePetIdentityLengths(
        { name: "Pampita", color: LONG_COLOR },
        { name: "Pampa", color: LONG_COLOR },
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a DIFFERENT over-long name even on an animal that already has one", () => {
    // The grandfather is for the value on the row, not a licence to type any
    // length once one long value exists.
    expect(
      resolvePetIdentityLengths(
        { name: `${LONG_NAME} y algo más`, color: null },
        { name: LONG_NAME, color: null },
      ),
    ).toEqual({ ok: false, code: "NAME_TOO_LONG" });
  });

  it("compares trimmed, so whitespace around a carried-over value is not a new value", () => {
    expect(
      resolvePetIdentityLengths(
        { name: LONG_NAME, color: null },
        { name: `  ${LONG_NAME}  `, color: null },
      ),
    ).toEqual({ ok: true });
  });

  it("treats a cleared colour as no colour rather than measuring null", () => {
    expect(resolvePetIdentityLengths({ name: "Pampa", color: null }, STORED)).toEqual({ ok: true });
  });

  it("reports the NAME first when both fields are over — one message, nearest the top", () => {
    expect(
      resolvePetIdentityLengths({ name: LONG_NAME, color: LONG_COLOR }, { name: "", color: null }),
    ).toEqual({ ok: false, code: "NAME_TOO_LONG" });
  });
});

describe("petIdentityFieldCap — the cap a control may truncate at", () => {
  it("is the constant when nothing longer is stored", () => {
    expect(petIdentityFieldCap(PET_NAME_MAX, "Pampa")).toBe(PET_NAME_MAX);
    expect(petIdentityFieldCap(PET_COLOR_MAX, null)).toBe(PET_COLOR_MAX);
  });

  it("rises to the stored length, so an input cannot shorten what is already there", () => {
    // A `TextInput` truncates the value it is handed. A fixed cap under a longer
    // stored name would put the shortened one on screen and store it on the next
    // save — an edit to the credential's own field that nobody asked for.
    expect(petIdentityFieldCap(PET_NAME_MAX, LONG_NAME)).toBe(LONG_NAME.length);
  });
});

describe("the service-dog commands (D3)", () => {
  const SAVE = {
    command: "save_service_dog",
    serviceType: "guia",
    trainingCenter: "Bocalan Argentina",
    trainingCertDate: null,
    rupgaCredential: null,
    credentialIssueDate: null,
    credentialExpiryDate: null,
    notes: null,
  };

  function firstCode(wire: unknown) {
    const parsed = petProfileCommandInputSchema.safeParse(wire);
    return parsed.success ? null : firstPetProfileCommandInputCode(parsed.error);
  }

  it("accepts the web form's shape, blanks folded to null", () => {
    const parsed = petProfileCommandInputSchema.parse({
      ...SAVE,
      rupgaCredential: "  ",
      notes: "",
    });
    expect(parsed).toMatchObject({ rupgaCredential: null, notes: null });
  });

  it("names the training centre when it is blank — the use-case's own first refusal", () => {
    expect(firstCode({ ...SAVE, trainingCenter: "   " })).toBe("TRAINING_CENTER_REQUIRED");
  });

  it("refuses a day that does not exist, and a type the table does not know", () => {
    expect(firstCode({ ...SAVE, credentialExpiryDate: "2026-02-31" })).toBe("DATE_INVALID");
    expect(firstCode({ ...SAVE, serviceType: "terapia" })).toBe("SERVICE_TYPE_INVALID");
  });

  it("drops a visibility riding on the save — the banner has its own command", () => {
    const parsed = petProfileCommandInputSchema.parse({ ...SAVE, publicVisibility: "full_banner" });
    expect(parsed).not.toHaveProperty("publicVisibility");
  });

  it("refuses a visibility outside the two the table admits", () => {
    expect(firstCode({ command: "set_service_dog_visibility", publicVisibility: "public" })).toBe(
      "VISIBILITY_INVALID",
    );
  });
});

// AN INSTALLED BUILD CANNOT BE UPDATED BY THIS COMMIT. Every phone that already
// has the app keeps sending these eight bodies, byte for byte, after the server
// learns a ninth command — so each one must still parse to exactly what it
// parsed to before (owner-pet-actions, 2026-10-01).
describe("the eight commands installed builds send keep parsing unchanged", () => {
  const INSTALLED_BODIES = [
    { command: "edit_identity", name: "Pampa", breed: "Caniche", color: null },
    {
      command: "set_emergency_contacts",
      preferredVetName: "Vet Norte",
      preferredVetPhone: "1122334455",
      emergencyContactName: "",
      emergencyContactPhone: "",
    },
    { command: "correct_species", species: "cat" },
    { command: "toggle_physical_tag_interest" },
    {
      command: "save_service_dog",
      serviceType: "guia",
      trainingCenter: "Bocalan Argentina",
      trainingCertDate: null,
      rupgaCredential: null,
      credentialIssueDate: null,
      credentialExpiryDate: null,
      notes: null,
    },
    { command: "request_service_dog_verification" },
    { command: "set_service_dog_visibility", publicVisibility: "private_only" },
    { command: "retire_service_dog" },
  ];

  it.each(INSTALLED_BODIES)("$command", (body) => {
    expect(petProfileCommandInputSchema.parse(body)).toEqual(body);
  });
});

describe("edit_profile — Editar datos by section (owner-pet-actions)", () => {
  /** Every section null: a valid body that edits nothing. */
  const NOTHING = {
    command: "edit_profile",
    identity: null,
    health: null,
    publicCredential: null,
    insurance: null,
    origin: null,
  };

  const IDENTITY = {
    name: "Pampa",
    breed: "Caniche",
    color: "Atigrada",
    sex: "female",
    ageYears: 5,
    ageMonths: 6,
  };

  const HEALTH = {
    favouriteFoods: ["Dieta casera"],
    knownAllergies: ["Pollo"],
    trainingLevel: "basic",
    permanentConditions: ["ciego"],
    permanentConditionsOther: null,
  };

  it("accepts a body that edits nothing — each section is null, not absent", () => {
    expect(petProfileCommandInputSchema.parse(NOTHING)).toEqual(NOTHING);
  });

  it("refuses a body that leaves a section key out: absent is not 'leave it'", () => {
    const { origin: _origin, ...withoutOrigin } = NOTHING;
    expect(petProfileCommandInputSchema.safeParse(withoutOrigin).success).toBe(false);
  });

  it("normalises each section the way the web form's parser does", () => {
    const parsed = petProfileCommandInputSchema.parse({
      ...NOTHING,
      identity: { ...IDENTITY, name: "  Pampa  ", breed: "", ageYears: "5", ageMonths: " " },
      health: { ...HEALTH, favouriteFoods: ["  Dieta casera ", "", "   "] },
      insurance: { insuranceCompany: "  Sancor Seguros ", insurancePolicyNumber: "" },
      origin: { acquisitionMethod: "adopted" },
      publicCredential: { emergencyInfoVisible: true, discloseConditionsPublicly: false },
    });
    expect(parsed).toEqual({
      command: "edit_profile",
      identity: { ...IDENTITY, breed: null, ageYears: 5, ageMonths: null },
      health: HEALTH,
      publicCredential: { emergencyInfoVisible: true, discloseConditionsPublicly: false },
      insurance: { insuranceCompany: "Sancor Seguros", insurancePolicyNumber: null },
      origin: { acquisitionMethod: "adopted" },
    });
  });

  // alta-validacion-edad: it CLAMPED ("3000" → 250), which let a typo become a
  // different stored number. Now the SHAPE is refused here and the RANGE is
  // `editedAgeRefusal`'s — it needs the stored date this schema never sees.
  it("refuses a malformed age instead of clamping it, and leaves the range to the stored-date gate", () => {
    expect(codeFor({ ...NOTHING, identity: { ...IDENTITY, ageMonths: -3 } })).toBe(
      "AGE_MONTHS_INVALID",
    );
    expect(codeFor({ ...NOTHING, identity: { ...IDENTITY, ageYears: "aprox 2" } })).toBe(
      "AGE_YEARS_INVALID",
    );
    // A large WHOLE number is a shape the schema accepts, unclamped: an age
    // posted back untouched may legitimately read as more than any cap.
    const parsed = petProfileCommandInputSchema.parse({
      ...NOTHING,
      identity: { ...IDENTITY, ageYears: 3000, ageMonths: 0 },
    });
    expect(parsed).toMatchObject({ identity: { ageYears: 3000, ageMonths: 0 } });
  });

  it("parses its own output back to itself", () => {
    const once = petProfileCommandInputSchema.parse({
      ...NOTHING,
      identity: IDENTITY,
      health: HEALTH,
      origin: { acquisitionMethod: null },
    });
    expect(petProfileCommandInputSchema.parse(once)).toEqual(once);
  });

  it("names a sex outside the three the column holds — an edit never guesses one", () => {
    expect(codeFor({ ...NOTHING, identity: { ...IDENTITY, sex: "hembra" } })).toBe("SEX_INVALID");
  });

  it("names a training level the column does not hold", () => {
    expect(codeFor({ ...NOTHING, health: { ...HEALTH, trainingLevel: "experto" } })).toBe(
      "TRAINING_LEVEL_INVALID",
    );
  });

  it("names an acquisition method outside the six", () => {
    expect(codeFor({ ...NOTHING, origin: { acquisitionMethod: "robado" } })).toBe(
      "ACQUISITION_METHOD_INVALID",
    );
  });

  it("requires the description when 'otra' is one of the conditions", () => {
    expect(
      codeFor({
        ...NOTHING,
        health: { ...HEALTH, permanentConditions: ["otra"], permanentConditionsOther: "  " },
      }),
    ).toBe("CONDITION_OTHER_REQUIRED");
  });

  it("refuses a description carrying a phone or an email — it can reach the public credential", () => {
    expect(
      codeFor({
        ...NOTHING,
        health: {
          ...HEALTH,
          permanentConditions: ["otra"],
          permanentConditionsOther: "displasia, llamar al 11 4567-8901",
        },
      }),
    ).toBe("CONDITION_OTHER_HAS_CONTACT");
  });

  it("does not police a description the web would drop — 'otra' is not selected", () => {
    expect(
      codeFor({
        ...NOTHING,
        health: { ...HEALTH, permanentConditionsOther: "llamar al 11 4567-8901" },
      }),
    ).toBeNull();
  });

  it("still refuses a blank name inside the identity section", () => {
    expect(codeFor({ ...NOTHING, identity: { ...IDENTITY, name: "   " } })).toBe("NAME_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// The free text of "Salud y cuidados" and "Seguro" — capped for NEW values only
// ---------------------------------------------------------------------------
//
// Same rule as the name and the colour above, for the same reason: the web's
// form parser never capped these columns, so longer values already exist, and a
// cap that refused them on the way back out would lock an owner out of the
// section that carries one. A value the animal already has passes at any length;
// a value being typed now does not.

describe("resolvePetProfileTextLengths — the free text of Salud y Seguro", () => {
  /** What the animal has today: short, ordinary values. */
  const STORED_TEXT = {
    favouriteFoods: ["Dieta casera"],
    knownAllergies: ["Pollo"],
    permanentConditionsOther: null,
    insuranceCompany: "Sancor Seguros",
    insurancePolicyNumber: "POL-1",
  };

  const health = (over: Partial<Record<string, unknown>> = {}) => ({
    favouriteFoods: ["Dieta casera"],
    knownAllergies: ["Pollo"],
    permanentConditions: [] as string[],
    permanentConditionsOther: null as string | null,
    ...over,
  });

  const insurance = (over: Partial<Record<string, unknown>> = {}) => ({
    insuranceCompany: "Sancor Seguros" as string | null,
    insurancePolicyNumber: "POL-1" as string | null,
    ...over,
  });

  const over = (cap: number) => "x".repeat(cap + 1);

  it("admits sections left alone, and values within every cap", () => {
    expect(resolvePetProfileTextLengths({ health: null, insurance: null }, STORED_TEXT)).toEqual({
      ok: true,
    });
    expect(
      resolvePetProfileTextLengths({ health: health(), insurance: insurance() }, STORED_TEXT),
    ).toEqual({ ok: true });
  });

  it("refuses a NEW insurance company past the cap, with a sentence naming the cap", () => {
    const answer = resolvePetProfileTextLengths(
      { health: null, insurance: insurance({ insuranceCompany: over(PET_INSURANCE_COMPANY_MAX) }) },
      STORED_TEXT,
    );
    expect(answer).toEqual({
      ok: false,
      code: "INSURANCE_COMPANY_TOO_LONG",
      message: `El nombre de la aseguradora es demasiado largo (máximo ${PET_INSURANCE_COMPANY_MAX} caracteres).`,
    });
  });

  it("refuses a NEW policy number past ITS cap, which is not the company's", () => {
    const answer = resolvePetProfileTextLengths(
      {
        health: null,
        insurance: insurance({ insurancePolicyNumber: over(PET_INSURANCE_POLICY_MAX) }),
      },
      STORED_TEXT,
    );
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("INSURANCE_POLICY_TOO_LONG");
    // Within the company's cap and past the policy's: the two numbers differ.
    expect(PET_INSURANCE_POLICY_MAX).toBeLessThan(PET_INSURANCE_COMPANY_MAX);
  });

  it("ADMITS the animal's own over-long company and policy, posted back unchanged", () => {
    const legacy = {
      ...STORED_TEXT,
      insuranceCompany: over(PET_INSURANCE_COMPANY_MAX),
      insurancePolicyNumber: over(PET_INSURANCE_POLICY_MAX),
    };
    expect(
      resolvePetProfileTextLengths(
        {
          health: null,
          insurance: insurance({
            // Whitespace around a carried-over value is not a new value.
            insuranceCompany: ` ${legacy.insuranceCompany} `,
            insurancePolicyNumber: legacy.insurancePolicyNumber,
          }),
        },
        legacy,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a DIFFERENT over-long company even on an animal that already has one", () => {
    const legacy = { ...STORED_TEXT, insuranceCompany: over(PET_INSURANCE_COMPANY_MAX) };
    const answer = resolvePetProfileTextLengths(
      {
        health: null,
        insurance: insurance({ insuranceCompany: `${over(PET_INSURANCE_COMPANY_MAX)}y` }),
      },
      legacy,
    );
    expect(answer.ok).toBe(false);
  });

  it("caps each NEW allergy and each NEW food, and keeps the ones already stored", () => {
    const longAllergy = over(PET_ALLERGY_ENTRY_MAX);
    const refused = resolvePetProfileTextLengths(
      { health: health({ knownAllergies: ["Pollo", longAllergy] }), insurance: null },
      STORED_TEXT,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("ALLERGY_TOO_LONG");
      expect(refused.message).toBe(
        `Cada alergia puede tener hasta ${PET_ALLERGY_ENTRY_MAX} caracteres.`,
      );
    }

    const longFood = over(PET_FOOD_ENTRY_MAX);
    const food = resolvePetProfileTextLengths(
      { health: health({ favouriteFoods: [longFood] }), insurance: null },
      STORED_TEXT,
    );
    expect(food.ok).toBe(false);
    if (!food.ok) expect(food.code).toBe("FOOD_TOO_LONG");

    // The same two entries, already on the animal: carried, not typed.
    const legacy = { ...STORED_TEXT, knownAllergies: [longAllergy], favouriteFoods: [longFood] };
    expect(
      resolvePetProfileTextLengths(
        {
          health: health({ knownAllergies: [longAllergy, "Huevo"], favouriteFoods: [longFood] }),
          insurance: null,
        },
        legacy,
      ),
    ).toEqual({ ok: true });
  });

  it("caps how many entries a list may grow to, but never below what is stored", () => {
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
    const tooMany = resolvePetProfileTextLengths(
      {
        health: health({ knownAllergies: many(PET_ALLERGIES_MAX + 1, "alergia") }),
        insurance: null,
      },
      STORED_TEXT,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe("ALLERGIES_TOO_MANY");

    const foods = resolvePetProfileTextLengths(
      { health: health({ favouriteFoods: many(PET_FOODS_MAX + 1, "comida") }), insurance: null },
      STORED_TEXT,
    );
    expect(foods.ok).toBe(false);
    if (!foods.ok) expect(foods.code).toBe("FOODS_TOO_MANY");

    // An animal that already holds more than the cap may keep them all, and
    // swap one for another — the list did not grow.
    const stored = many(PET_ALLERGIES_MAX + 3, "alergia");
    const swapped = [...stored.slice(1), "Huevo"];
    expect(
      resolvePetProfileTextLengths(
        { health: health({ knownAllergies: swapped }), insurance: null },
        { ...STORED_TEXT, knownAllergies: stored },
      ),
    ).toEqual({ ok: true });
  });

  it("caps the 'otra' description at the web form's own length, only when 'otra' is chosen", () => {
    const long = over(PET_CONDITION_OTHER_MAX);
    const refused = resolvePetProfileTextLengths(
      {
        health: health({ permanentConditions: ["otra"], permanentConditionsOther: long }),
        insurance: null,
      },
      STORED_TEXT,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("CONDITION_OTHER_TOO_LONG");
    // Without "otra" the text is dropped on save, so there is nothing to cap.
    expect(
      resolvePetProfileTextLengths(
        { health: health({ permanentConditionsOther: long }), insurance: null },
        STORED_TEXT,
      ),
    ).toEqual({ ok: true });
    // And the animal's own over-long description passes, posted back.
    expect(
      resolvePetProfileTextLengths(
        {
          health: health({ permanentConditions: ["otra"], permanentConditionsOther: long }),
          insurance: null,
        },
        { ...STORED_TEXT, permanentConditionsOther: long },
      ),
    ).toEqual({ ok: true });
  });

  it("reports the HEALTH refusal first when both sections are over — one message, nearest the top", () => {
    const answer = resolvePetProfileTextLengths(
      {
        health: health({ knownAllergies: [over(PET_ALLERGY_ENTRY_MAX)] }),
        insurance: insurance({ insuranceCompany: over(PET_INSURANCE_COMPANY_MAX) }),
      },
      STORED_TEXT,
    );
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("ALLERGY_TOO_LONG");
  });

  it("gives every code an es-AR sentence that names its number", () => {
    const numbers: Record<string, number> = {
      ALLERGIES_TOO_MANY: PET_ALLERGIES_MAX,
      ALLERGY_TOO_LONG: PET_ALLERGY_ENTRY_MAX,
      FOODS_TOO_MANY: PET_FOODS_MAX,
      FOOD_TOO_LONG: PET_FOOD_ENTRY_MAX,
      CONDITION_OTHER_TOO_LONG: PET_CONDITION_OTHER_MAX,
      INSURANCE_COMPANY_TOO_LONG: PET_INSURANCE_COMPANY_MAX,
      INSURANCE_POLICY_TOO_LONG: PET_INSURANCE_POLICY_MAX,
    };
    expect(Object.keys(PET_PROFILE_TEXT_LENGTH_MESSAGES).sort()).toEqual(
      [...PET_PROFILE_TEXT_LENGTH_CODES].sort(),
    );
    for (const code of PET_PROFILE_TEXT_LENGTH_CODES) {
      expect(PET_PROFILE_TEXT_LENGTH_MESSAGES[code]).toContain(String(numbers[code]));
    }
  });

  it("keeps the 'otra' cap at the web form's own maxLength — one field, one number", () => {
    expect(PET_CONDITION_OTHER_MAX).toBe(120);
  });
});
