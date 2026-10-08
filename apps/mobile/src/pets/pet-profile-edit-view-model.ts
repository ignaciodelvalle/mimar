// Editar — turning the server's answer into what a person reads, and what they
// typed into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a draft to a
// `PetProfileCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `shares-view-model.ts` and `lost-view-model.ts` both follow. What lives
// here is the WORDS: the contract carries codes, the consumer owns its copy.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `payload.capabilities` carries TWO booleans because the two halves of this
// screen answer to two different rules — identity is every holder except a
// caretaker, the contacts are the legal owner alone. A screen that derived
// either from "this pet is mine" would show a foster in transit the titular's
// own vet and phone number, which is exactly the fix the web made in its M2
// review and exactly what this app must not undo.

import type { PetProfileDraftV1, PetProfileEditV1 } from "@dim/contract/api";
import type {
  AcquisitionMethod,
  PetProfileCommandInput,
  PetProfileCommandInputCode,
  PetProfileTextLengthCode,
  PetSex,
  PetSpecies,
  StatedAgeCode,
  StoredPetIdentityText,
  StoredPetProfileText,
} from "@dim/contract/input";
import {
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_PHONE_MAX,
  PET_COLOR_MAX,
  PET_CONDITION_OTHER_MAX,
  PET_INSURANCE_COMPANY_MAX,
  PET_INSURANCE_POLICY_MAX,
  PET_NAME_MAX,
  PET_SPECIES,
  SERVICE_DOG_NOTES_MAX,
  SERVICE_DOG_RUPGA_MAX,
  SERVICE_DOG_TRAINING_CENTER_MAX,
  editedAgeRefusal,
  firstPetProfileCommandInputCode,
  petIdentityFieldCap,
  petProfileCommandInputSchema,
  resolvePetIdentityLengths,
  resolvePetProfileTextLengths,
} from "@dim/contract/input";
import {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  PERMANENT_CONDITIONS,
  TRAINING_LEVELS,
  TRAINING_LEVEL_VALUES,
  type TrainingLevel,
  breedsForSpecies,
  maxStatedAgeYears,
  petAgeFromBirthDate,
} from "@dim/contract/reference";

import { PET_EDIT_SECTIONS, type PetEditSection } from "../ui/routes";
import { AR_TIME_ZONE } from "./libreta-view-model";
import { ACQUISITION_ORDER, acquisitionMethodLabel } from "./pet-field-options";

/**
 * The section a `?seccion=` names, or `null` — which opens the screen at the top.
 *
 * AN UNKNOWN SECTION IS NOT AN ERROR, it is the default: the posture the pet
 * document takes with an unknown `?face=`. A link naming a section this build
 * does not have still points at a real animal's data, and refusing to open the
 * form over a query string would turn a cosmetic disagreement into a dead link.
 * Takes the raw parameter because expo-router types a query value as
 * `string | string[]`.
 */
export function petEditSectionFromParam(
  raw: string | readonly string[] | undefined,
): PetEditSection | null {
  const first = (typeof raw === "string" ? raw : raw?.[0])?.trim() ?? "";
  return (PET_EDIT_SECTIONS as readonly string[]).includes(first)
    ? (first as PetEditSection)
    : null;
}

/** The identity form's fields, as strings — what a `TextInput` actually holds. */
export type IdentityDraft = {
  name: string;
  breed: string;
  color: string;
};

/** The contacts form's fields. Empty means "clear the override". */
export type EmergencyDraft = {
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

/**
 * The caps the CONTACTS form puts on its own inputs, from the contract.
 *
 * The two identity fields are not here: their cap depends on what the animal
 * already holds — see `identityFieldCaps`.
 */
export const FIELD_LIMITS = {
  contactName: EMERGENCY_CONTACT_NAME_MAX,
  contactPhone: EMERGENCY_CONTACT_PHONE_MAX,
} as const;

/**
 * The `maxLength` the two identity inputs may carry for THIS animal.
 *
 * A FIXED CAP HERE SILENTLY EDITS THE PET. `TextInput` truncates the value it is
 * handed, so an animal whose stored name is longer than `PET_NAME_MAX` would
 * arrive on screen already shortened and the next "Guardar datos" would write
 * the shortened name — a correction nobody asked for, to the field the
 * credential is read by. `petIdentityFieldCap` raises the cap to whatever is
 * stored, which is the same grandfather `resolvePetIdentityLengths` grants the
 * value on the way back.
 */
export function identityFieldCaps(payload: PetProfileEditV1): { name: number; color: number } {
  return {
    name: petIdentityFieldCap(PET_NAME_MAX, payload.identity.name),
    color: petIdentityFieldCap(PET_COLOR_MAX, payload.identity.color),
  };
}

/** The server's current values, as the form should start. */
export function identityDraftFrom(payload: PetProfileEditV1): IdentityDraft {
  return {
    name: payload.identity.name,
    breed: payload.identity.breed ?? "",
    color: payload.identity.color ?? "",
  };
}

/**
 * The contacts form's starting values, or `null` when this caller may not have
 * them.
 *
 * `null` IS NOT AN EMPTY DRAFT and the difference is the whole point: the server
 * sends `emergencyContacts: null` for anybody but the legal owner, and a screen
 * that turned that into four blank inputs would be offering a form whose save
 * can only be refused.
 */
export function emergencyDraftFrom(payload: PetProfileEditV1): EmergencyDraft | null {
  if (payload.emergencyContacts === null) return null;
  return { ...payload.emergencyContacts };
}

/**
 * The breed options to offer: the species catalog, plus the animal's CURRENT
 * stored breed when the catalog does not contain it.
 *
 * THE APPENDED VALUE IS THE PARITY BIT, not a nicety. `resolveBreedForWrite`
 * grandfathers a stored off-catalog breed so a legacy value survives an
 * unrelated edit (QA A5), and the web's edit form appends it as its own
 * `<option>` for exactly that reason. Without this, a picker that only ever
 * offered the catalog would leave the owner of a pet recorded as something the
 * catalog no longer lists with two choices — pick a different breed, or leave —
 * and the "leave" one is the one that silently wipes the value the moment they
 * correct the name.
 */
export function breedChoicesFor(species: string, storedBreed: string | null): string[] {
  const catalog = breedsForSpecies(species);
  const stored = storedBreed?.trim() ?? "";
  if (stored.length === 0 || catalog.includes(stored)) return catalog;
  return [stored, ...catalog];
}

/** Why the identity form is not offered, or `null` when it is. */
export function identityBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canEditIdentity) return null;
  // NEUTRAL, not "sos cuidador/a": this flag refuses more than a caretaker now
  // (owner-pet-actions, security review of 3babbe25a) — a user-held custody row
  // and the org path reach it too, and naming either of them a caretaker would
  // be false.
  return "Editar sus datos es solo del titular.";
}

/**
 * The species chip the correction card starts on: the animal's own, when this
 * build knows it — `null` for a species the contract's list does not carry, so
 * the picker shows nothing selected rather than a chip that is not the animal.
 */
export function speciesDraftFrom(payload: PetProfileEditV1): PetSpecies | null {
  const stored = payload.species.trim();
  return (PET_SPECIES as readonly string[]).includes(stored) ? (stored as PetSpecies) : null;
}

/** Why the species correction is not offered, or `null` when it is. */
export function speciesBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canCorrectSpecies) return null;
  // The same refusal as the identity form, said about THIS act, because the
  // web's own `NotTitularNotice` names what was asked for. No "cuidador/a": the
  // flag now refuses the org path and a user-held custody too (owner-pet-
  // actions). NOT the identity sentence's "es solo del titular" wording: the two
  // cards can be blocked on one screen at once, and two sentences a test cannot
  // tell apart are two sentences a person reads as one.
  return "La especie la corrige el titular.";
}

/** Why the contacts form is not offered, or `null` when it is. */
export function contactsBlockedReason(payload: PetProfileEditV1): string | null {
  if (payload.capabilities.canEditEmergencyContacts) return null;
  // NOT the same sentence as above, and not "solo el titular" either: a co-owner
  // and a foster both reach this, and both ARE holders. What they are not is the
  // person whose phone number this is.
  return "Estos son el veterinario y el contacto de quien figura como dueño/a. Solo esa persona puede cambiarlos.";
}

/**
 * What a person will see if they clear a field — the account-level default, or
 * an honest "nada".
 *
 * The pair (name + phone) falls back TOGETHER, never mixed across levels: that
 * is `lib/domain/emergency-contacts.ts`, the server's one implementation, and
 * this function reports its inputs rather than re-deriving its rule. It answers
 * per PAIR for the same reason.
 */
export function accountFallbackLabel(payload: PetProfileEditV1, pair: "vet" | "emergency"): string {
  const fallback = payload.emergencyAccountDefault;
  if (fallback === null) return "";
  const name = pair === "vet" ? fallback.preferredVetName : fallback.emergencyContactName;
  const phone = pair === "vet" ? fallback.preferredVetPhone : fallback.emergencyContactPhone;
  const parts = [name, phone].filter((v): v is string => v !== null && v.trim().length > 0);
  if (parts.length === 0) {
    return "Si dejás los dos campos vacíos no se muestra nada: tu cuenta tampoco tiene uno cargado.";
  }
  return `Si dejás los dos campos vacíos mostramos el de tu cuenta: ${parts.join(" · ")}.`;
}

export type CommandResult =
  | { ok: true; input: PetProfileCommandInput }
  | {
      ok: false;
      message: string;
      /**
       * The schema's code, or — for Salud and Seguro — the free-text cap's.
       * Two vocabularies on purpose: the caps' sentences travel with their codes
       * (`PET_PROFILE_TEXT_LENGTH_MESSAGES`), so they never pass through
       * `petProfileInputCodeMessage`'s exhaustive switch.
       */
      code: PetProfileCommandInputCode | PetProfileTextLengthCode | null;
    };

/** Exported for the sibling screens that post to the same endpoint (D3's service dog). */
export function validated(wire: unknown): CommandResult {
  const parsed = petProfileCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstPetProfileCommandInputCode(parsed.error);
  return { ok: false, code, message: petProfileInputCodeMessage(code) };
}

/**
 * EDITAR LOS DATOS.
 *
 * An empty `breed` or `color` travels as `null`, which CLEARS the field — the
 * contract's own semantics, and the reason the two are required keys rather
 * than optional ones. A person who empties the colour box means to empty it.
 *
 * IT TAKES THE STORED VALUES because the length rule needs them. The cap gates
 * NEW text only: an animal already recorded with a name longer than
 * `PET_NAME_MAX` must still be able to have its COLOUR corrected, and this form
 * posts both fields on every save. Passing the payload's own `identity` is what
 * makes the local refusal agree with the server's, field for field — a screen
 * that refused what the endpoint would accept is the same bug as one that
 * offered what it would refuse.
 */
export function buildIdentityEdit(
  draft: IdentityDraft,
  stored: StoredPetIdentityText,
): CommandResult {
  const name = draft.name.trim();
  const color = draft.color.trim() || null;
  const lengths = resolvePetIdentityLengths({ name, color }, stored);
  if (!lengths.ok) {
    return { ok: false, code: lengths.code, message: petProfileInputCodeMessage(lengths.code) };
  }
  return validated({
    command: "edit_identity",
    name: draft.name,
    breed: draft.breed.trim() || null,
    color,
  });
}

/**
 * CORREGIR LA ESPECIE. Validated against the contract's own `PET_SPECIES`, so a
 * chip this build drew can never post a value the registry refuses.
 */
export function buildCorrectSpecies(species: PetSpecies | null): CommandResult {
  return validated({ command: "correct_species", species });
}

/** GUARDAR LOS CONTACTOS. All four fields travel every time; empty clears. */
export function buildEmergencyContacts(draft: EmergencyDraft): CommandResult {
  return validated({
    command: "set_emergency_contacts",
    preferredVetName: draft.preferredVetName,
    preferredVetPhone: draft.preferredVetPhone,
    emergencyContactName: draft.emergencyContactName,
    emergencyContactPhone: draft.emergencyContactPhone,
  });
}

/**
 * D2 — ALTERNAR INTERÉS EN LA CHAPA FÍSICA. No fields: the direction the
 * toggle takes is the server's own fact about the existing row, never
 * something a client states — see the contract's own note on the command.
 */
export function buildTogglePhysicalTagInterest(): CommandResult {
  return validated({ command: "toggle_physical_tag_interest" });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function petProfileInputCodeMessage(code: PetProfileCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "NAME_REQUIRED":
      return "El nombre no puede quedar vacío.";
    case "NAME_INVALID":
      // NAMES WHAT IS WRONG WITHOUT NAMING THE CHARACTER. A person who pasted a
      // name with an invisible character in it cannot see the character, so
      // "sacá el U+200B" would be useless; "escribilo con letras" is the move
      // that works for every string this rule refuses.
      return "Ese nombre no se puede mostrar. Escribilo con letras.";
    case "NAME_TOO_LONG":
      return `El nombre es demasiado largo (máximo ${PET_NAME_MAX} caracteres).`;
    case "COLOR_TOO_LONG":
      return `El color es demasiado largo (máximo ${PET_COLOR_MAX} caracteres).`;
    case "CONTACT_NAME_TOO_LONG":
      return `Ese nombre es demasiado largo (máximo ${EMERGENCY_CONTACT_NAME_MAX} caracteres).`;
    case "CONTACT_PHONE_TOO_LONG":
      return `Ese teléfono es demasiado largo (máximo ${EMERGENCY_CONTACT_PHONE_MAX} caracteres).`;
    case "SPECIES_INVALID":
      // The web form's own sentence for the same refusal.
      return "Elegí una especie válida.";
    // D3 — the service-dog form.
    case "SERVICE_TYPE_INVALID":
      return "Elegí el tipo de servicio.";
    case "TRAINING_CENTER_REQUIRED":
      // The web use-case's own sentence for the same refusal.
      return "Indicá el centro de entrenamiento.";
    case "TRAINING_CENTER_TOO_LONG":
      return `El centro de entrenamiento es demasiado largo (máximo ${SERVICE_DOG_TRAINING_CENTER_MAX} caracteres).`;
    case "RUPGA_TOO_LONG":
      return `El número RUPGA es demasiado largo (máximo ${SERVICE_DOG_RUPGA_MAX} caracteres).`;
    case "NOTES_TOO_LONG":
      return `Las notas son demasiado largas (máximo ${SERVICE_DOG_NOTES_MAX} caracteres).`;
    case "DATE_INVALID":
      return "Revisá las fechas: escribilas como DD/MM/AAAA y que el día exista.";
    case "VISIBILITY_INVALID":
      return "La app no pudo armar la acción. Volvé a intentar.";
    // owner-pet-actions — "Editar datos" by section.
    case "SEX_INVALID":
      return "Elegí el sexo de la mascota.";
    case "TRAINING_LEVEL_INVALID":
      return "Elegí un nivel de entrenamiento de la lista.";
    case "ACQUISITION_METHOD_INVALID":
      return "Elegí cómo llegó la mascota de la lista.";
    case "CONDITION_OTHER_REQUIRED":
      return "Describí la otra condición.";
    // alta-validacion-edad — the alta's own sentences (`register-input.ts`).
    // AGE_TOO_HIGH names no number here because it has no species; the builder
    // that has one says the cap (`editedAgeMessage`).
    case "AGE_YEARS_INVALID":
      return "Poné los años como un número entero, por ejemplo 3.";
    case "AGE_MONTHS_INVALID":
      return "Poné los meses como un número entero, por ejemplo 6.";
    case "AGE_MONTHS_OUT_OF_RANGE":
      return "Si pusiste años, los meses van de 0 a 11.";
    case "AGE_TOO_HIGH":
      return "Revisá la edad: ese número no puede ser la edad de tu mascota.";
    case "CONDITION_OTHER_HAS_CONTACT":
      // The web parser's own sentence for the same refusal (`parsePetForm`).
      return "La descripción de la condición no puede incluir teléfonos ni emails: puede mostrarse en la credencial pública. Escribila sin datos de contacto.";
  }
}

/**
 * What the screen says after a save landed.
 *
 * A NO-OP IS A SUCCESS and "listo" would be true but unhelpful. The server
 * measures `changed` against the values it already held, so a person who opened
 * the form, changed their mind and pressed Guardar gets told that nothing
 * needed saving rather than being congratulated on a write that did not happen.
 * The species no-op is the web form's own sentence — there, a refusal; here,
 * the same fact reported as the outcome of a tap.
 */
export function savedLabel(command: PetProfileCommandInput["command"], changed: boolean): string {
  switch (command) {
    case "edit_identity":
      return changed
        ? "Listo. El cambio queda registrado en la libreta."
        : "No había nada que cambiar: ya estaba así.";
    case "set_emergency_contacts":
      return changed
        ? "Listo. Guardamos los contactos de esta mascota."
        : "No había nada que cambiar: los contactos ya estaban así.";
    case "correct_species":
      return changed
        ? "Listo. La corrección queda registrada en la libreta."
        : "La especie es la misma; no hay nada que corregir.";
    // Not "queda registrado en la libreta": a section can change only the
    // credential's emergency-info toggle, which writes no asiento.
    case "edit_profile":
      return changed
        ? "Listo. Guardamos los cambios."
        : "No había nada que cambiar: ya estaba así.";
    // UNREACHABLE VIA THIS FUNCTION — the toggle's ack carries `state`, never
    // `changed` (see the contract's own note on `PetProfileEditAckV1`), and the
    // screen that sends it reads `physicalTagInterestSavedLabel` instead. Kept
    // here only because the switch is exhaustive over every command this
    // contract knows.
    case "toggle_physical_tag_interest":
      return "Listo.";
    // UNREACHABLE VIA THIS FUNCTION for the same reason: the four service-dog
    // acts live on `ServiceDogScreen`, whose acks carry no `changed`, and it
    // reads `serviceDogSavedLabel` instead.
    case "save_service_dog":
    case "request_service_dog_verification":
    case "set_service_dog_visibility":
    case "retire_service_dog":
      return "Listo.";
  }
}

/**
 * D2 — the sentence after a toggle lands, from the ack's own `state` and
 * nothing else: the direction is the fact, and there is no `changed` to be
 * "no-op" about — every successful call DOES change the row.
 */
export function physicalTagInterestSavedLabel(state: "interested" | "cancelled"): string {
  return state === "interested"
    ? "Quedaste anotado. Te vamos a escribir cuando haya un canal disponible en tu zona."
    : "Cancelaste el interés.";
}

/**
 * D2 — the title and body BEFORE a tap, from the payload's own section. The
 * web sheet's own two sentences (`PhysicalTagInterestSheet.tsx`), read here
 * instead of restated: "estamos midiendo interés, no se cobra todavía" is a
 * product claim and this app must say the same thing the web does.
 */
export function physicalTagInterestTitle(petName: string, interested: boolean): string {
  return interested ? "Chapa física — anotado" : `¿Querés una chapa física para ${petName}?`;
}

export function physicalTagInterestBody(petName: string, interested: boolean): string {
  return interested
    ? "Una chapita con el QR que cuelga del collar. Ya avisaste que te interesa."
    : `Una chapita con el QR de ${petName} que cuelga del collar. Si alguien la encuentra, escanea y ve su libreta.`;
}

/** The date line under "anotado", or `null` when there is none to show. */
export function physicalTagInterestRequestedAtLabel(requestedAt: string | null): string | null {
  if (requestedAt === null) return null;
  const date = new Date(requestedAt);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  }).format(date);
  return `Anotado el ${formatted}.`;
}

// ---------------------------------------------------------------------------
// "Editar datos" by section (owner-pet-actions, PO plan 2026-10-01)
// ---------------------------------------------------------------------------
//
// THE GAP. The app's "Editar datos" could change the name, the breed and the
// colour; the web's form changes fifteen fields. The PO's plan closes it in
// SECTIONS, the same six on both platforms — Identidad, Salud y cuidados,
// Contactos, Qué muestra la credencial pública, Seguro, Origen — each with its
// own Guardar.
//
// ONE SECTION PER SAVE, ON THE WIRE AND ON THE SCREEN. `edit_profile` takes
// every section as a required, nullable key, and `null` means "leave it as
// stored"; so each builder below sends its own object and `null` for the other
// four. A Guardar that sent everything would write whatever another section's
// half-typed draft held. The screen keeps the same promise in the other
// direction: after a save it re-seeds THAT section from the server and leaves
// what was typed elsewhere alone (`reseedDrafts`).
//
// WHAT IS STILL NOT A SECTION, each with its own door: the contacts
// (`set_emergency_contacts`), the species (`correct_species`, FULL-LOCK), the
// weight (an asiento), the microchip and the locality (a mudanza).

/**
 * One save group of the screen. Identidad holds two (its form, and the species
 * correction, which is its own command); every other section holds one.
 */
export type SaveGroup =
  | "identity"
  | "species"
  | "contacts"
  | "health"
  | "publicCredential"
  | "insurance"
  | "origin";

/** The two Identidad fields only the sectioned edit carries. The age is what the inputs hold. */
export type IdentityExtrasDraft = { sex: PetSex; ageYears: string; ageMonths: string };

/**
 * Salud y cuidados, the way the web's form holds it: catalogue CHIPS, plus the
 * owner's own entries as comma-separated text. Chips stay in catalogue order
 * (`toggleCatalogPick`); a stored condition code the catalogue has dropped rides
 * at the end of `conditions` so posting the section back keeps it.
 */
export type HealthDraft = {
  foods: string[];
  foodsOther: string;
  allergies: string[];
  allergiesOther: string;
  trainingLevel: TrainingLevel | null;
  conditions: string[];
  conditionsOther: string;
};

export type PublicCredentialDraft = {
  emergencyInfoVisible: boolean;
  discloseConditionsPublicly: boolean;
};

export type InsuranceDraft = { insuranceCompany: string; insurancePolicyNumber: string };

export type OriginDraft = { acquisitionMethod: AcquisitionMethod | null };

export type ProfileDrafts = {
  identityExtras: IdentityExtrasDraft;
  health: HealthDraft;
  publicCredential: PublicCredentialDraft;
  insurance: InsuranceDraft;
  origin: OriginDraft;
};

/** Everything the screen lets a person type, by section. */
export type EditDrafts = {
  identity: IdentityDraft;
  species: PetSpecies | null;
  contacts: EmergencyDraft | null;
  /** `null` when the profile sections are not offered (`profileBlockedReason`). */
  profile: ProfileDrafts | null;
};

/**
 * The profile block, when THIS caller may edit it. `undefined` covers an older
 * server that sends no key at all; it reads like `null` — no sections.
 */
function editableProfile(payload: PetProfileEditV1): PetProfileDraftV1 | null {
  if (payload.capabilities.canEditProfile !== true) return null;
  return payload.profile ?? null;
}

/** Catalogue picks in catalogue order, then whatever else is stored. */
function splitByCatalog(catalog: readonly string[], stored: readonly string[]) {
  return {
    picks: catalog.filter((item) => stored.includes(item)),
    rest: stored.filter((item) => !catalog.includes(item)),
  };
}

function healthDraftFrom(profile: PetProfileDraftV1): HealthDraft {
  const foods = splitByCatalog(COMMON_FOODS, profile.favouriteFoods);
  const allergies = splitByCatalog(COMMON_ALLERGIES, profile.knownAllergies);
  const conditions = splitByCatalog(PERMANENT_CONDITIONS, profile.permanentConditions);
  return {
    foods: foods.picks,
    foodsOther: foods.rest.join(", "),
    allergies: allergies.picks,
    allergiesOther: allergies.rest.join(", "),
    trainingLevel: profile.trainingLevel,
    conditions: [...conditions.picks, ...conditions.rest],
    conditionsOther: profile.permanentConditionsOther ?? "",
  };
}

/** A whole number as the input shows it; no number is an empty box, never "0". */
function ageField(value: number | null): string {
  return value === null ? "" : String(value);
}

function profileDraftsFrom(profile: PetProfileDraftV1, now: Date): ProfileDrafts {
  // THE AGE THE STORED DATE READS AS TODAY, on Argentina's calendar — the same
  // function the server uses to decide that an unchanged age keeps the stored
  // date (`resolveEditedBirthDate`). Posting this back untouched is what stops
  // every save from re-estimating the birth date, the web bug this change fixed.
  const age = petAgeFromBirthDate(profile.dateOfBirth, now);
  return {
    identityExtras: {
      sex: profile.sex,
      ageYears: ageField(age.years),
      ageMonths: ageField(age.months),
    },
    health: healthDraftFrom(profile),
    publicCredential: {
      emergencyInfoVisible: profile.emergencyInfoVisible,
      discloseConditionsPublicly: profile.discloseConditionsPublicly,
    },
    insurance: {
      insuranceCompany: profile.insuranceCompany ?? "",
      insurancePolicyNumber: profile.insurancePolicyNumber ?? "",
    },
    origin: { acquisitionMethod: profile.acquisitionMethod },
  };
}

/**
 * Every draft the screen holds, seeded from the server. `now` is a parameter so
 * the age is computed ONCE per read: a baseline recomputed on every render would
 * change at midnight and mark an untouched form as edited.
 */
export function editDraftsFrom(payload: PetProfileEditV1, now: Date): EditDrafts {
  const profile = editableProfile(payload);
  return {
    identity: identityDraftFrom(payload),
    species: speciesDraftFrom(payload),
    contacts: emergencyDraftFrom(payload),
    profile: profile === null ? null : profileDraftsFrom(profile, now),
  };
}

/** Why the profile sections are not offered, or `null` when they are. */
export function profileBlockedReason(payload: PetProfileEditV1): string | null {
  if (editableProfile(payload) !== null) return null;
  if (payload.capabilities.canEditProfile === true) {
    // Allowed, and the block did not arrive: a read problem, not a permission.
    return "No pudimos cargar esta sección.";
  }
  if (!payload.capabilities.canEditIdentity) {
    return "Sos cuidador/a de esta mascota. Estos datos los edita el titular.";
  }
  return "Tu acceso a esta mascota no incluye editar esta sección.";
}

type ProfileSectionKey = keyof ProfileDrafts;

function withProfileSection(
  current: ProfileDrafts | null,
  fresh: ProfileDrafts | null,
  key: ProfileSectionKey,
): ProfileDrafts | null {
  if (fresh === null) return null;
  if (current === null) return fresh;
  return { ...current, [key]: fresh[key] };
}

/**
 * The drafts after `group` was saved and the server re-read: THAT group
 * re-seeded from what the server stored, every other section as the person left
 * it. A species correction re-seeds the identity fields too, because the server
 * may have cleared a breed the new species' catalogue does not carry.
 */
export function reseedDrafts(current: EditDrafts, fresh: EditDrafts, group: SaveGroup): EditDrafts {
  switch (group) {
    case "identity":
      return {
        ...current,
        identity: fresh.identity,
        profile: withProfileSection(current.profile, fresh.profile, "identityExtras"),
      };
    case "species":
      return {
        ...current,
        species: fresh.species,
        identity: fresh.identity,
        profile: withProfileSection(current.profile, fresh.profile, "identityExtras"),
      };
    case "contacts":
      return { ...current, contacts: fresh.contacts };
    case "health":
    case "publicCredential":
    case "insurance":
    case "origin":
      return { ...current, profile: withProfileSection(current.profile, fresh.profile, group) };
  }
}

/**
 * Whether two sets of drafts say the same thing — the discard guard's question.
 *
 * NOT `sameDraft`: that one is shallow over primitives by design, and these
 * sections hold lists, where a shallow test would call a new chip "unchanged".
 * Serialising is exact here because every draft is built by the functions above
 * and edited by spreading, so two equal drafts have their keys in one order.
 */
export function sameEditDrafts(a: EditDrafts, b: EditDrafts): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Turn a chip on or off. The catalogue's picks come back in CATALOGUE order,
 * whatever order they were tapped in, so a deselect-reselect is not an edit;
 * anything selected that the catalogue does not carry (a legacy code) is kept,
 * after them.
 */
export function toggleCatalogPick(
  catalog: readonly string[],
  selected: readonly string[],
  value: string,
): string[] {
  const on = new Set(selected);
  if (on.has(value)) on.delete(value);
  else on.add(value);
  return [
    ...catalog.filter((item) => on.has(item)),
    ...selected.filter((item) => !catalog.includes(item) && on.has(item)),
  ];
}

/** Comma-separated entries, trimmed, blanks dropped — the web parser's rule. */
function splitEntries(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** First occurrence wins: a chip and the same word typed again are one entry. */
function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

type ProfileSections = Partial<
  Record<"identity" | "health" | "publicCredential" | "insurance" | "origin", unknown>
>;

/** `edit_profile` with the given sections and `null` — "leave it" — for the rest. */
function editProfileWire(sections: ProfileSections) {
  return {
    command: "edit_profile",
    identity: null,
    health: null,
    publicCredential: null,
    insurance: null,
    origin: null,
    ...sections,
  };
}

/**
 * GUARDAR IDENTIDAD. The three identity fields plus the sex and the age, posted
 * as the inputs hold them. Takes the PAYLOAD for what is stored: the name and
 * colour for the same grandfathered length rule `buildIdentityEdit` applies,
 * and the species and birth date for the age rule below.
 *
 * THE AGE (alta-validacion-edad, 2026-10-07): `editedAgeRefusal`, the rule the
 * server runs, before the round trip — the server answers a bare
 * `invalid_request`, so the field has to be named here. An age posted back as
 * shown passes at any value (a stored date the old clamp let through must not
 * block a colour fix); a TYPED one is held to the alta's rule and cap. `now` is
 * the save's instant; the match tolerates the day the form may have opened on.
 */
export function buildProfileIdentity(
  identity: IdentityDraft,
  extras: IdentityExtrasDraft,
  payload: PetProfileEditV1,
  now: Date,
): CommandResult {
  const name = identity.name.trim();
  const color = identity.color.trim() || null;
  const lengths = resolvePetIdentityLengths({ name, color }, payload.identity);
  if (!lengths.ok) {
    return { ok: false, code: lengths.code, message: petProfileInputCodeMessage(lengths.code) };
  }
  const ageCode = editedAgeRefusal(
    { species: payload.species, ageYears: extras.ageYears, ageMonths: extras.ageMonths },
    editableProfile(payload)?.dateOfBirth ?? null,
    now,
  );
  if (ageCode !== null) {
    return { ok: false, code: ageCode, message: editedAgeMessage(ageCode, payload.species) };
  }
  return validated(
    editProfileWire({
      identity: {
        name: identity.name,
        breed: identity.breed.trim() || null,
        color,
        sex: extras.sex,
        ageYears: extras.ageYears,
        ageMonths: extras.ageMonths,
      },
    }),
  );
}

/** The alta's sentences for the age (`register-input.ts`), with this species' cap. */
function editedAgeMessage(code: StatedAgeCode, species: string): string {
  return code === "AGE_TOO_HIGH"
    ? `Revisá la edad: no puede pasar de ${maxStatedAgeYears(species)} años.`
    : petProfileInputCodeMessage(code);
}

/**
 * The free-text caps of Salud and Seguro, run on what the SCHEMA produced.
 *
 * THE SERVER'S OWN GATE, BEFORE THE ROUND TRIP. `edit_profile` answers an
 * over-cap NEW value with a bare `invalid_request` — no field, by design: the
 * contract leaves naming the field to the client that runs the same gate first.
 * So this runs `resolvePetProfileTextLengths` on the parsed command (trimmed,
 * blanks dropped: what the server measures) against what the animal already
 * holds, and a refusal carries the contract's sentence for that field. A value
 * the animal already has passes at any length, exactly as it does on the server.
 */
function withinTextCaps(built: CommandResult, stored: StoredPetProfileText): CommandResult {
  if (!built.ok || built.input.command !== "edit_profile") return built;
  const lengths = resolvePetProfileTextLengths(
    { health: built.input.health, insurance: built.input.insurance },
    stored,
  );
  return lengths.ok ? built : { ok: false, code: lengths.code, message: lengths.message };
}

/**
 * GUARDAR SALUD Y CUIDADOS. Chips, then the typed entries, de-duplicated. Takes
 * the STORED profile for the free-text caps (`withinTextCaps`).
 */
export function buildProfileHealth(
  draft: HealthDraft,
  stored: StoredPetProfileText,
): CommandResult {
  const built = validated(
    editProfileWire({
      health: {
        favouriteFoods: unique([...draft.foods, ...splitEntries(draft.foodsOther)]),
        knownAllergies: unique([...draft.allergies, ...splitEntries(draft.allergiesOther)]),
        trainingLevel: draft.trainingLevel,
        permanentConditions: [...draft.conditions],
        permanentConditionsOther: draft.conditionsOther,
      },
    }),
  );
  return withinTextCaps(built, stored);
}

/** GUARDAR QUÉ MUESTRA LA CREDENCIAL PÚBLICA. The two toggles and nothing else. */
export function buildProfilePublicCredential(draft: PublicCredentialDraft): CommandResult {
  return validated(editProfileWire({ publicCredential: { ...draft } }));
}

/** GUARDAR SEGURO. An emptied field clears it; a NEW value is capped (`withinTextCaps`). */
export function buildProfileInsurance(
  draft: InsuranceDraft,
  stored: StoredPetProfileText,
): CommandResult {
  return withinTextCaps(validated(editProfileWire({ insurance: { ...draft } })), stored);
}

/**
 * The `maxLength` the capped single-line inputs may carry for THIS animal —
 * `identityFieldCaps`' rule for the other three free-text fields the web form
 * also caps: the contract's constant, raised to whatever is already stored, so
 * an input never truncates a legacy value into a correction nobody asked for.
 * The two lists have no input-level cap: an entry is one of several in a box,
 * and the save measures each one (`withinTextCaps`).
 */
export function profileFieldCaps(
  profile: Pick<
    PetProfileDraftV1,
    "permanentConditionsOther" | "insuranceCompany" | "insurancePolicyNumber"
  >,
): { conditionOther: number; insuranceCompany: number; insurancePolicyNumber: number } {
  return {
    conditionOther: petIdentityFieldCap(PET_CONDITION_OTHER_MAX, profile.permanentConditionsOther),
    insuranceCompany: petIdentityFieldCap(PET_INSURANCE_COMPANY_MAX, profile.insuranceCompany),
    insurancePolicyNumber: petIdentityFieldCap(
      PET_INSURANCE_POLICY_MAX,
      profile.insurancePolicyNumber,
    ),
  };
}

/** GUARDAR ORIGEN. One of the six methods, or none. */
export function buildProfileOrigin(draft: OriginDraft): CommandResult {
  return validated(editProfileWire({ origin: { ...draft } }));
}

/**
 * The "No especificar" answer of a single-choice row. The kit's `Choice` has no
 * way to un-pick, and the web's selects open on the same option, so the unset
 * answer is an option of its own — a sentinel that never crosses the wire.
 */
export const UNSET_CHOICE = "sin_dato";
const UNSET_LABEL = "No especificar";

export type TrainingChoice = TrainingLevel | typeof UNSET_CHOICE;
export const TRAINING_CHOICES: readonly TrainingChoice[] = [UNSET_CHOICE, ...TRAINING_LEVEL_VALUES];

const TRAINING_LABELS: ReadonlyMap<string, string> = new Map(
  TRAINING_LEVELS.map((level) => [level.value, level.label]),
);

/** The catalogue's own words for a level; "No especificar" for the unset answer. */
export function trainingChoiceLabel(choice: TrainingChoice): string {
  return TRAINING_LABELS.get(choice) ?? UNSET_LABEL;
}

export type AcquisitionChoice = AcquisitionMethod | typeof UNSET_CHOICE;
export const ACQUISITION_CHOICES: readonly AcquisitionChoice[] = [
  UNSET_CHOICE,
  ...ACQUISITION_ORDER,
];

/** The alta's own words for a method; "No especificar" for the unset answer. */
export function acquisitionChoiceLabel(choice: AcquisitionChoice): string {
  return choice === UNSET_CHOICE ? UNSET_LABEL : acquisitionMethodLabel(choice);
}

/** A choice back to the draft's value: the sentinel is `null`. */
export function fromChoice<T extends string>(choice: T | typeof UNSET_CHOICE): T | null {
  return choice === UNSET_CHOICE ? null : (choice as T);
}

/** The draft's value as a choice: `null` is the sentinel. */
export function toChoice<T extends string>(value: T | null): T | typeof UNSET_CHOICE {
  return value ?? UNSET_CHOICE;
}
