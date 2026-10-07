// Client-input contract for EDITAR —
// `POST /api/v1/pets/{publicToken}/profile`.
//
// THREE COMMANDS, ONE ENDPOINT, TWO DIFFERENT GUARDS. The read's contract
// (`@dim/contract/api`'s `pet-profile-edit.ts`) states the guards at length and
// this file does not restate them, because two copies of a rule is how the
// copies disagree. What matters here is that the split into COMMANDS is not
// cosmetic: one appends a bundled `pet_profile_updated` event to the spine, one
// moves four preference columns and appends nothing, and one — the species
// correction — appends its OWN `pet_profile_updated` on the FULL-LOCK path the
// identity edit refuses to touch. A single "save everything" command would have
// had to pick one guard and one event for all three.
//
// THE REFERENCE POINTS, named by SYMBOL and not by line: a line number in a
// comment is a fact about a file's length, and it rots on the next edit to
// anything above it. These names are greppable and do not.
//
//   editar identidad     `updatePetAction`                 src/modules/pets/actions.ts
//   contactos            `updateEmergencyContactsAction`   app/actions/profile.ts
//                        + `updateEmergencyContactsForPet` …/profile/update-emergency-contacts.ts
//   corregir especie     `correctPetSpeciesAction`         src/modules/pets/actions.ts
//                        + `correctPetSpecies`             …/profile/correct-species.ts
//
// WHAT THE SERVER STILL DECIDES AFTER THIS SCHEMA PASSES
// ---------------------------------------------------------------------------
//   · THE BREED. `resolveBreedForWrite` (lib/domain/breed-validation.ts) folds
//     and aliases the submitted label against the catalog for the PERSISTED
//     species and rejects anything that does not land in it — a dog may not be
//     saved as "Persa". A client picks from `breedsForSpecies` to avoid the
//     round trip; it does not decide.
//   · THE PPP FLAG. `potentially_dangerous_breed` is re-resolved against the
//     animal's jurisdiction on every write. It is legally load-bearing state and
//     no client input reaches it.
//   · WHETHER ANYTHING CHANGED. A no-op edit appends no event.
//
// WHY NO LENGTH CAP IN THIS SCHEMA REACHES `name`, `breed` OR `color`
// ---------------------------------------------------------------------------
// `pets.name` and `pets.color` are `text`, and `ln()` — the web's own form
// parser, the only writer either column has ever had — checks that the name is
// non-empty and nothing else. So values longer than any number this file could
// pick ALREADY EXIST in those columns, and a cap enforced by the schema would be
// applied to them on the way back OUT: `edit_identity` carries all three fields
// on every save, so an animal whose stored name runs to 120 characters could not
// have its COLOUR corrected either. The owner is locked out of their own record
// by a limit invented after their data — and locked out from the phone, where
// there is no second door.
//
// That failure has a name here already. QA A5 is the same shape one field over:
// `resolveBreedForWrite` accepts a submitted breed UNCHANGED when it equals the
// one stored on the animal, so a legacy off-catalog value survives an unrelated
// edit instead of being wiped by a picker that never offered it, and
// `breedChoicesFor` is that rule reaching the UI. `resolvePetIdentityLengths`
// below is the same rule again: the cap gates NEW values, and a value identical
// to the one already on the animal passes at any length.
//
// It therefore CANNOT live in `petProfileCommandInputSchema`. That schema is a
// function of the request alone and has never seen the row, so it cannot tell a
// 120-character name being carried over from a 120-character name being typed —
// which is the entire distinction. The gate is a separate function both sides
// call with the stored values: the server in `profile/commands.ts`, beside the
// breed gate it mirrors, and the client before the round trip.
//
// THE TWO CONTACT CAPS STAY IN THE SCHEMA, and the asymmetry is not an
// oversight. They are not narrowings this contract invented: they are the
// numbers `update-emergency-contacts.ts` already enforces (`nameField` ≤ 80,
// `phoneField` ≤ 40), so an over-long stored value cannot have come through the
// only writer those columns have, and if one somehow existed the WEB's sheet
// would refuse it identically. Mirroring a server cap is parity; inventing one
// over unbounded legacy data is the lockout above.

import { z } from "zod";

import { detectContactInfoInFreeText } from "../reference/contact-in-free-text.ts";
import { TRAINING_LEVEL_VALUES } from "../reference/pet-profile-options.ts";
import { PET_SEXES } from "./intake.ts";
// From the leaves, NOT from `register-pet.ts`: that file imports this one's
// length caps, so importing it back from here closes a cycle — and both files
// build zod schemas at module-evaluation time, where a cycle turns the other
// side's constants into `undefined`. See `pet-species.ts`.
import { ACQUISITION_METHODS } from "./pet-profile-fields.ts";
import { PET_SPECIES } from "./pet-species.ts";
import {
  SERVICE_DOG_NOTES_MAX,
  SERVICE_DOG_RUPGA_MAX,
  SERVICE_DOG_TRAINING_CENTER_MAX,
  SERVICE_DOG_TYPES,
  SERVICE_DOG_VISIBILITIES,
  optionalServiceDogDay,
  optionalServiceDogText,
} from "./service-dog.ts";
import { STATED_AGE_CODES, statedAgeCount } from "./stated-age.ts";
import { isWritableName } from "./writable-name.ts";

/**
 * The longest a NEW pet name may be.
 *
 * NOT a cap on what the column may hold — see the header. It gates values a
 * person is typing now; whatever the animal already carries passes at any
 * length, through `resolvePetIdentityLengths`.
 */
export const PET_NAME_MAX = 80;

/** The longest a NEW colour description may be. Same rule as the name. */
export const PET_COLOR_MAX = 80;

/**
 * The server's own cap on a contact NAME, mirrored rather than invented —
 * `update-emergency-contacts.ts` rejects longer with "Máximo 80 caracteres".
 */
export const EMERGENCY_CONTACT_NAME_MAX = 80;

/**
 * The server's own cap on a contact PHONE. Forty, not eighty: the column holds a
 * dialable string, and the web's field agrees. Format is NEVER validated — the
 * writer says so out loud ("a soft client-side warning, never a server error"),
 * because a national registry that refused an unusual but real number would be
 * refusing the one call that matters during an emergency.
 */
export const EMERGENCY_CONTACT_PHONE_MAX = 40;

/**
 * The vocabulary a client shows a field message from.
 *
 * TWO OF THEM DO NOT COME FROM THE SCHEMA. `NAME_TOO_LONG` and `COLOR_TOO_LONG`
 * are `resolvePetIdentityLengths`' answers, because a length rule that
 * grandfathers the stored value cannot be a `.max()` on a schema that has never
 * seen the row. They are listed here anyway: the vocabulary belongs to the
 * COMMAND, not to whichever layer happens to detect the problem.
 */
export const PET_PROFILE_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "NAME_REQUIRED",
  "NAME_INVALID",
  "NAME_TOO_LONG",
  "COLOR_TOO_LONG",
  "CONTACT_NAME_TOO_LONG",
  "CONTACT_PHONE_TOO_LONG",
  "SPECIES_INVALID",
  // D3 — the service-dog form's own five.
  "SERVICE_TYPE_INVALID",
  "TRAINING_CENTER_REQUIRED",
  "TRAINING_CENTER_TOO_LONG",
  "RUPGA_TOO_LONG",
  "NOTES_TOO_LONG",
  "DATE_INVALID",
  "VISIBILITY_INVALID",
  // owner-pet-actions — the sectioned `edit_profile`'s own five.
  "SEX_INVALID",
  "TRAINING_LEVEL_INVALID",
  "ACQUISITION_METHOD_INVALID",
  "CONDITION_OTHER_REQUIRED",
  "CONDITION_OTHER_HAS_CONTACT",
  // alta-validacion-edad — the identity section's age. The schema raises the
  // two shape codes; the range codes come from `editedAgeRefusal`, which needs
  // the stored date, and are listed so a client's copy covers all four.
  ...STATED_AGE_CODES,
] as const;
export type PetProfileCommandInputCode = (typeof PET_PROFILE_COMMAND_INPUT_CODES)[number];

/** A trimmed optional string; absent, blank and `null` all mean "not stated". */
const optionalBreed = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/** Same shape as the breed, and capped by the same grandfather-aware gate. */
const optionalColor = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * Edit the animal's identity.
 *
 * `name` IS REQUIRED because the column is `not null` and the credential is
 * addressed by it everywhere a person reads one. `breed` and `color` are
 * required KEYS with nullable values, not optional keys, for the reason
 * `createLibretaShare` makes about `expiresInDays`: an absent field would have
 * to mean either "leave it" or "clear it", the two are different acts, and a
 * contract that let a client ask for the ambiguity would have to invent an
 * answer. Posting `null` clears; posting the current value leaves it.
 */
/**
 * The name, as both identity commands take it.
 *
 * NOT `.max(PET_NAME_MAX)`: the length rule needs the stored value to tell a
 * carried-over name from a typed one. `resolvePetIdentityLengths` is it.
 *
 * The SHAPE rule is different in kind and belongs here: a name made of
 * zero-width spaces is not a name at any length, there is nothing to grandfather
 * (no writer can have stored one — the edit and alta doors all refuse it), and a
 * rename to `"​​"` would blank the animal's credential
 * (A2-alta-asentar-09).
 */
const writablePetName = z
  .string({ error: "NAME_REQUIRED" })
  .trim()
  .min(1, { error: "NAME_REQUIRED" })
  .refine(isWritableName, { error: "NAME_INVALID" });

const editIdentity = z.object({
  command: z.literal("edit_identity"),
  name: writablePetName,
  breed: optionalBreed,
  color: optionalColor,
});

/** What the animal already holds in the two capped free-text columns. */
export type StoredPetIdentityText = {
  name: string;
  color: string | null;
};

export type PetIdentityLengthResolution =
  | { ok: true }
  | { ok: false; code: "NAME_TOO_LONG" | "COLOR_TOO_LONG" };

/**
 * The length gate for `edit_identity`, applied to NEW VALUES ONLY.
 *
 * The grandfather rule, stated once: a submitted value identical to the one
 * already stored on the animal passes at any length. That is
 * `resolveBreedForWrite`'s own comparison (QA A5) applied to the two columns
 * that have a number instead of a catalog, and it is the whole reason this is a
 * function of the ROW and the request rather than a `.max()` on the schema.
 *
 * WHY THE ORDER OF THE TWO CHECKS IS FIXED: the first refusal wins, and it is
 * the name's, matching `firstPetProfileCommandInputCode` — one message, and the
 * one nearest the top of the form.
 *
 * Both sides call it. The client, holding the payload it pre-filled from, says
 * so before the round trip; the server, holding the row the guard read, enforces
 * it. Neither derives a rule of its own.
 */
export function resolvePetIdentityLengths(
  edit: { name: string; color: string | null },
  stored: StoredPetIdentityText,
): PetIdentityLengthResolution {
  if (exceedsCap(edit.name, PET_NAME_MAX, stored.name)) {
    return { ok: false, code: "NAME_TOO_LONG" };
  }
  if (exceedsCap(edit.color, PET_COLOR_MAX, stored.color)) {
    return { ok: false, code: "COLOR_TOO_LONG" };
  }
  return { ok: true };
}

/**
 * The longest this field may be RIGHT NOW, for a control that truncates.
 *
 * A `maxLength` fixed at the cap is not a milder version of the refusal above —
 * it is worse. React Native's `TextInput` truncates the VALUE it is handed, so a
 * 120-character stored name pre-filled into an input capped at 80 arrives on
 * screen already shortened, and the next save writes the shortened one. The
 * refusal locks an owner out; the truncation edits their animal's name without
 * being asked. Both halves need the same grandfather, so both take it from here.
 */
export function petIdentityFieldCap(cap: number, stored: string | null): number {
  const storedLength = stored?.trim().length ?? 0;
  return storedLength > cap ? storedLength : cap;
}

function exceedsCap(value: string | null, cap: number, stored: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length <= cap) return false;
  // Grandfathered: what the animal already has, posted back unchanged.
  return trimmed !== (stored?.trim() ?? "");
}

const contactName = z
  .string()
  .trim()
  .max(EMERGENCY_CONTACT_NAME_MAX, { error: "CONTACT_NAME_TOO_LONG" });

const contactPhone = z
  .string()
  .trim()
  .max(EMERGENCY_CONTACT_PHONE_MAX, { error: "CONTACT_PHONE_TOO_LONG" });

/**
 * Set this animal's emergency-contact OVERRIDE.
 *
 * ALL FOUR FIELDS ARE REQUIRED AND AN EMPTY STRING IS MEANINGFUL: it clears the
 * pet-level override so the account default shows through again. That is the
 * web sheet's own behaviour — it posts all four every time — and it is why the
 * fields are not optional: an omitted key would be indistinguishable from a
 * cleared one, and the writer would have to guess which of two different acts
 * the person meant.
 */
const setEmergencyContacts = z.object({
  command: z.literal("set_emergency_contacts"),
  preferredVetName: contactName,
  preferredVetPhone: contactPhone,
  emergencyContactName: contactName,
  emergencyContactPhone: contactPhone,
});

/**
 * Correct the animal's SPECIES — the FULL-LOCK path (PO decision #40).
 *
 * NOT A FIELD OF `edit_identity`, deliberately, and the read's contract says why
 * at length: species drives PPP/compliance, so the profile-edit writer omits the
 * column from its `SET` and a genuine correction goes through its own use-case
 * (`correctPetSpecies`), which appends its own `pet_profile_updated`, clears a
 * breed the new species' catalog does not carry, and re-resolves the PPP flag.
 * That is the web's `corregir-especie` sheet, and this command is the same
 * door.
 *
 * THE VOCABULARY IS THE CONTRACT'S OWN `PET_SPECIES`, so a client cannot post a
 * species this registry does not know; the use-case checks the same list again
 * behind the schema, for the web form that has no schema in front of it.
 *
 * POSTING THE SPECIES THE ANIMAL ALREADY HAS IS A SUCCESS WITH `changed: false`,
 * never a refusal — a correction's success invalidates its own precondition, so
 * a retry that lost its response must answer the way the first attempt did.
 */
const correctSpecies = z.object({
  command: z.literal("correct_species"),
  species: z.enum(PET_SPECIES, { error: "SPECIES_INVALID" }),
});

/**
 * D2 (2026-09-25) — the §4.20 physical-tag interest toggle, reaching the
 * IDENTICAL use-case `togglePhysicalTagInterestAction` reaches
 * (`togglePhysicalTagInterest`, `src/modules/pets/application/
 * physical-tag-interest/`). NO FIELDS: the web action takes only the pet's
 * token, and the toggle's direction is a fact the SERVER holds (the existing
 * row's `cancelled_at`), never something a client states.
 */
const togglePhysicalTagInterest = z.object({
  command: z.literal("toggle_physical_tag_interest"),
});

/**
 * D3 (2026-09-25) — GUARDAR LOS DATOS DEL PERRO DE ASISTENCIA, reaching the
 * IDENTICAL use-case `upsertServiceDogAction` reaches (`upsertServiceDog`,
 * `src/modules/pets/application/service-dog/`).
 *
 * THE FIELDS ARE THE WEB FORM'S, and every key is REQUIRED with a nullable
 * value — the form posts all seven on every save, and the use-case writes all
 * seven (`value || null`) on update, so an omitted key would have to mean
 * either "leave it" or "clear it" and the writer only knows the second.
 *
 * `publicVisibility` IS NOT A FIELD, although the use-case's input type has
 * one: the web form never sends it, so on the web an upsert keeps the stored
 * visibility (or `private_only` for a new row). The banner has its own command
 * below, gated in the UI on a vigente, in-service credential — exposing it here
 * too would be a second, ungated way to turn on a public disclosure of the
 * owner's disability (Ley 25.326 Art. 7).
 */
const saveServiceDog = z.object({
  command: z.literal("save_service_dog"),
  serviceType: z.enum(SERVICE_DOG_TYPES, { error: "SERVICE_TYPE_INVALID" }),
  trainingCenter: z
    .string({ error: "TRAINING_CENTER_REQUIRED" })
    .trim()
    .min(1, { error: "TRAINING_CENTER_REQUIRED" })
    .max(SERVICE_DOG_TRAINING_CENTER_MAX, { error: "TRAINING_CENTER_TOO_LONG" }),
  trainingCertDate: optionalServiceDogDay,
  rupgaCredential: optionalServiceDogText(SERVICE_DOG_RUPGA_MAX, "RUPGA_TOO_LONG"),
  credentialIssueDate: optionalServiceDogDay,
  credentialExpiryDate: optionalServiceDogDay,
  notes: optionalServiceDogText(SERVICE_DOG_NOTES_MAX, "NOTES_TOO_LONG"),
});

/**
 * D3 — SOLICITAR VERIFICACIÓN: `submitServiceDogVerificationRequestAction`'s
 * use-case. No fields: the request is built server-side from the stored row.
 */
const requestServiceDogVerification = z.object({
  command: z.literal("request_service_dog_verification"),
});

/** D3 — the public banner on/off: `setServiceDogVisibilityAction`'s use-case. */
const setServiceDogVisibility = z.object({
  command: z.literal("set_service_dog_visibility"),
  publicVisibility: z.enum(SERVICE_DOG_VISIBILITIES, { error: "VISIBILITY_INVALID" }),
});

/** D3 — retirar del servicio: `retireServiceDogAction`'s use-case. */
const retireServiceDog = z.object({
  command: z.literal("retire_service_dog"),
});

// ---------------------------------------------------------------------------
// EDITAR DATOS, BY SECTION — `edit_profile` (owner-pet-actions, 2026-10-01)
// ---------------------------------------------------------------------------
//
// The app's "Editar datos" could change three fields; the web's could change
// fifteen. This command closes the gap: one section per Guardar, the same
// sections the web form shows, through the same `updatePet` the web's
// `updatePetAction` reaches.
//
// EVERY SECTION KEY IS REQUIRED AND NULLABLE. `null` means "this section was not
// edited — leave every field of it as stored"; an object means "this section,
// exactly as the screen shows it". A missing key is refused rather than read as
// either, for the reason `edit_identity` gives about its fields: "leave it" and
// "clear it" are different acts, and an absent key would have to guess.
//
// WHAT IS NOT A SECTION HERE, each with its own door already: the contacts
// (`set_emergency_contacts`), the species (`correct_species`, FULL-LOCK), the
// weight (an asiento, "Anotar → Peso"), the microchip (its own protocol) and the
// locality (a mudanza, `/move`).
//
// THE FREE TEXT IS CAPPED FOR NEW VALUES ONLY — `resolvePetProfileTextLengths`
// below, and not a `.max()` here, for the reason this file's header gives about
// `name` and `color`: the web's parser capped none of these columns, so longer
// values already exist, and a cap applied on the way back out would lock an
// owner out of the section that carries one. The schema still sees no row; the
// gate does.

/** Trimmed free text; absent, blank and `null` all mean "not stated". */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/** A list of free-text entries: each trimmed, blanks dropped — the web parser's rule. */
const textList = z.array(z.string().trim()).transform((items) => items.filter((s) => s !== ""));

/** Identidad: the three `edit_identity` fields plus the sex and the age. */
const profileIdentity = z.object({
  name: writablePetName,
  breed: optionalBreed,
  color: optionalColor,
  // REFUSED, never caught to "unknown" as the alta does: on a registration the
  // fallback costs nothing, on an edit it would overwrite a known sex.
  sex: z.enum(PET_SEXES, { error: "SEX_INVALID" }),
  // The age the screen shows, posted back. The server keeps the stored birth
  // date when this is the age that date reads as, and estimates a new one only
  // when it is not (`resolveEditedBirthDate`). Both blank clears the date.
  //
  // SHAPE ONLY HERE, and refused rather than clamped (alta-validacion-edad):
  // the RANGE depends on the stored date — an age posted back untouched passes
  // at any value, a TYPED one is held to the alta's cap — and this schema sees
  // no row. The server and both clients run `editedAgeRefusal` for it.
  ageYears: statedAgeCount("AGE_YEARS_INVALID"),
  ageMonths: statedAgeCount("AGE_MONTHS_INVALID"),
});

/**
 * The "otra" description is required when "otra" is chosen, and may not carry
 * a phone or an email: it can render on the PUBLIC credential. When "otra" is
 * not chosen the text is dropped on save, so it is not policed.
 */
function refineConditionOther(
  health: { permanentConditions: string[]; permanentConditionsOther: string | null },
  ctx: z.RefinementCtx,
) {
  if (!health.permanentConditions.includes("otra")) return;
  const other = health.permanentConditionsOther;
  if (other === null) {
    ctx.addIssue({
      code: "custom",
      message: "CONDITION_OTHER_REQUIRED",
      path: ["permanentConditionsOther"],
    });
    return;
  }
  if (detectContactInfoInFreeText(other) !== null) {
    ctx.addIssue({
      code: "custom",
      message: "CONDITION_OTHER_HAS_CONTACT",
      path: ["permanentConditionsOther"],
    });
  }
}

/**
 * Salud y cuidados. Condition codes are free strings here and filtered on save
 * against the catalog — keeping any code the animal already carries — rather
 * than refused, so a stored legacy code survives being posted back.
 */
const profileHealth = z
  .object({
    favouriteFoods: textList,
    knownAllergies: textList,
    trainingLevel: z.enum(TRAINING_LEVEL_VALUES, { error: "TRAINING_LEVEL_INVALID" }).nullable(),
    permanentConditions: textList,
    permanentConditionsOther: optionalText,
  })
  .superRefine(refineConditionOther);

/**
 * Qué muestra la credencial pública. These two DO change what other people see,
 * which no other field of this endpoint does — see the route's limiter note.
 */
const profilePublicCredential = z.object({
  emergencyInfoVisible: z.boolean(),
  discloseConditionsPublicly: z.boolean(),
});

/** Seguro. */
const profileInsurance = z.object({
  insuranceCompany: optionalText,
  insurancePolicyNumber: optionalText,
});

/** Origen. Refused outside the six, unlike the alta's silent fallback — see `sex`. */
const profileOrigin = z.object({
  acquisitionMethod: z
    .enum(ACQUISITION_METHODS, { error: "ACQUISITION_METHOD_INVALID" })
    .nullable(),
});

const editProfile = z.object({
  command: z.literal("edit_profile"),
  identity: profileIdentity.nullable(),
  health: profileHealth.nullable(),
  publicCredential: profilePublicCredential.nullable(),
  insurance: profileInsurance.nullable(),
  origin: profileOrigin.nullable(),
});

// ---------------------------------------------------------------------------
// The free text of Salud and Seguro — capped for NEW values (security review,
// owner-pet-actions phases 1-2)
// ---------------------------------------------------------------------------
//
// Until this existed the sectioned edit took any length: a list of allergies a
// megabyte long would have been written to the row and copied into the
// append-only `pet_profile_updated` payload, where nothing can ever trim it.
// The numbers are the web's where the web has one and the repo's short-text
// convention where it does not.
//
// THE GRANDFATHER RULE IS `resolvePetIdentityLengths`' one: a value identical to
// the one already on the animal passes at any length, so a legacy row stays
// readable AND savable. Only what a person is typing now is measured. Each side
// calls it with the stored values — the server in both write doors
// (`profile/commands.ts` and `updatePetAction`), a client before the round trip.
//
// THE SENTENCE TRAVELS WITH THE CODE, unlike `PET_PROFILE_COMMAND_INPUT_CODES`,
// whose copy the app keeps in an exhaustive switch: seven codes there would have
// had to land with seven sentences in the app in the same commit. A code that
// brings its own es-AR sentence is shown as-is by the web form and by any client
// that runs this gate before posting. The server answers a refusal with
// `invalid_request` and no field detail, as it does for the identity lengths.

/**
 * The longest a NEW allergy may be. The catalog's longest entry is 22
 * characters; eighty is the repo's short-text cap (the name, the colour, a
 * contact name) and leaves free text room to describe one allergy.
 */
export const PET_ALLERGY_ENTRY_MAX = 80;

/** The longest a NEW favourite food may be. Same number, same reason. */
export const PET_FOOD_ENTRY_MAX = 80;

/**
 * How many allergies a NEW list may hold. Above the catalog (eleven) with room
 * for free text; an animal that already holds more keeps them.
 */
export const PET_ALLERGIES_MAX = 20;

/** How many favourite foods a NEW list may hold. The catalog has eight. */
export const PET_FOODS_MAX = 20;

/**
 * The longest a NEW "otra" description may be — the web form's own `maxLength`
 * on that input (PetForm's sensitive section), mirrored rather than invented.
 * It can render on the PUBLIC credential, which is one more reason to bound it.
 */
export const PET_CONDITION_OTHER_MAX = 120;

/** The longest a NEW insurance company may be: a company name, the name's cap. */
export const PET_INSURANCE_COMPANY_MAX = 80;

/**
 * The longest a NEW policy number may be. Forty, the phone's number: it is an
 * identifier a person reads off a card, not prose.
 */
export const PET_INSURANCE_POLICY_MAX = 40;

/** In the order a form reports them: Salud's top to bottom, then Seguro's. */
export const PET_PROFILE_TEXT_LENGTH_CODES = [
  "ALLERGIES_TOO_MANY",
  "ALLERGY_TOO_LONG",
  "FOODS_TOO_MANY",
  "FOOD_TOO_LONG",
  "CONDITION_OTHER_TOO_LONG",
  "INSURANCE_COMPANY_TOO_LONG",
  "INSURANCE_POLICY_TOO_LONG",
] as const;
export type PetProfileTextLengthCode = (typeof PET_PROFILE_TEXT_LENGTH_CODES)[number];

/** The es-AR sentence for each code — see the block above for why it lives here. */
export const PET_PROFILE_TEXT_LENGTH_MESSAGES: Readonly<Record<PetProfileTextLengthCode, string>> =
  {
    ALLERGIES_TOO_MANY: `Cargaste demasiadas alergias: el máximo es ${PET_ALLERGIES_MAX}.`,
    ALLERGY_TOO_LONG: `Cada alergia puede tener hasta ${PET_ALLERGY_ENTRY_MAX} caracteres.`,
    FOODS_TOO_MANY: `Cargaste demasiadas comidas: el máximo es ${PET_FOODS_MAX}.`,
    FOOD_TOO_LONG: `Cada comida puede tener hasta ${PET_FOOD_ENTRY_MAX} caracteres.`,
    CONDITION_OTHER_TOO_LONG: `La descripción de la condición es demasiado larga (máximo ${PET_CONDITION_OTHER_MAX} caracteres).`,
    INSURANCE_COMPANY_TOO_LONG: `El nombre de la aseguradora es demasiado largo (máximo ${PET_INSURANCE_COMPANY_MAX} caracteres).`,
    INSURANCE_POLICY_TOO_LONG: `El número de póliza es demasiado largo (máximo ${PET_INSURANCE_POLICY_MAX} caracteres).`,
  };

/** What the animal already holds in the capped columns. The `pets` row fits. */
export type StoredPetProfileText = {
  favouriteFoods: readonly string[] | null;
  knownAllergies: readonly string[] | null;
  permanentConditionsOther: string | null;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
};

/** The two sections the gate reads — `null` when the save leaves one alone. */
export type PetProfileTextEdit = {
  health: {
    favouriteFoods: readonly string[];
    knownAllergies: readonly string[];
    permanentConditions: readonly string[];
    permanentConditionsOther: string | null;
  } | null;
  insurance: {
    insuranceCompany: string | null;
    insurancePolicyNumber: string | null;
  } | null;
};

export type PetProfileTextLengthResolution =
  | { ok: true }
  | { ok: false; code: PetProfileTextLengthCode; message: string };

function refuse(code: PetProfileTextLengthCode): PetProfileTextLengthResolution {
  return { ok: false, code, message: PET_PROFILE_TEXT_LENGTH_MESSAGES[code] };
}

/**
 * A list's two caps: how many entries, and how long a NEW entry. An entry the
 * animal already has passes at any length; the count may reach what is stored
 * when that is more than the cap, so swapping one entry for another on a legacy
 * list is not refused for the length of the list it did not grow.
 */
function listRefusal(
  submitted: readonly string[],
  stored: readonly string[] | null,
  caps: { count: number; entry: number },
  codes: { count: PetProfileTextLengthCode; entry: PetProfileTextLengthCode },
): PetProfileTextLengthResolution | null {
  const kept = (stored ?? []).map((entry) => entry.trim());
  if (submitted.length > Math.max(caps.count, kept.length)) return refuse(codes.count);
  for (const entry of submitted) {
    const trimmed = entry.trim();
    if (trimmed.length > caps.entry && !kept.includes(trimmed)) return refuse(codes.entry);
  }
  return null;
}

/**
 * The length gate for the free text of `edit_profile`'s Salud and Seguro, and
 * of the web form that edits the same columns — applied to NEW VALUES ONLY.
 *
 * The first refusal wins, in `PET_PROFILE_TEXT_LENGTH_CODES` order: one message,
 * the one nearest the top of the form. The "otra" description is measured only
 * when "otra" is chosen — otherwise it is dropped on save and there is nothing
 * to keep.
 */
export function resolvePetProfileTextLengths(
  edit: PetProfileTextEdit,
  stored: StoredPetProfileText,
): PetProfileTextLengthResolution {
  const health = edit.health;
  if (health) {
    const refusal =
      listRefusal(
        health.knownAllergies,
        stored.knownAllergies,
        { count: PET_ALLERGIES_MAX, entry: PET_ALLERGY_ENTRY_MAX },
        { count: "ALLERGIES_TOO_MANY", entry: "ALLERGY_TOO_LONG" },
      ) ??
      listRefusal(
        health.favouriteFoods,
        stored.favouriteFoods,
        { count: PET_FOODS_MAX, entry: PET_FOOD_ENTRY_MAX },
        { count: "FOODS_TOO_MANY", entry: "FOOD_TOO_LONG" },
      );
    if (refusal) return refusal;
    if (
      health.permanentConditions.includes("otra") &&
      exceedsCap(
        health.permanentConditionsOther,
        PET_CONDITION_OTHER_MAX,
        stored.permanentConditionsOther,
      )
    ) {
      return refuse("CONDITION_OTHER_TOO_LONG");
    }
  }
  const insurance = edit.insurance;
  if (insurance) {
    if (
      exceedsCap(insurance.insuranceCompany, PET_INSURANCE_COMPANY_MAX, stored.insuranceCompany)
    ) {
      return refuse("INSURANCE_COMPANY_TOO_LONG");
    }
    if (
      exceedsCap(
        insurance.insurancePolicyNumber,
        PET_INSURANCE_POLICY_MAX,
        stored.insurancePolicyNumber,
      )
    ) {
      return refuse("INSURANCE_POLICY_TOO_LONG");
    }
  }
  return { ok: true };
}

export const petProfileCommandInputSchema = z.discriminatedUnion("command", [
  editIdentity,
  setEmergencyContacts,
  correctSpecies,
  togglePhysicalTagInterest,
  saveServiceDog,
  requestServiceDogVerification,
  setServiceDogVisibility,
  retireServiceDog,
  editProfile,
]);

export type PetProfileCommandInput = z.infer<typeof petProfileCommandInputSchema>;
export type PetProfileCommand = PetProfileCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstShareCommandInputCode` — same shape, same reason.
 */
export function firstPetProfileCommandInputCode(
  error: z.ZodError<unknown>,
): PetProfileCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_PROFILE_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetProfileCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
