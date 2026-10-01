// Composing a `ParsedPet` for a SECTIONED profile edit — the sections "Editar
// datos" saves one at a time, laid over everything the animal already has.
//
// GENERALISES `pet-identity-edit.ts` (owner-pet-actions, 2026-10-01). That file
// solved the problem for three fields; the sectioned screen has six sections
// with their own Guardar, and the problem is the same one at a larger size:
// `PetsRepository.updatePetProfile` writes SEVENTEEN columns from `parsed` in one
// unconditional `SET`, so a request that names one section must be composed
// with every other section exactly as stored, or the save of an allergy wipes
// the insurance policy with a 200 and a `pet_profile_updated` event recording
// the wipe as if somebody had asked for it. `composePetIdentityEdit` is now the
// identity section of this composer, and its own header still says what is
// deliberately NOT carried (the five legacy chip columns, `localityId`, the
// constant `custodyKind`) — the same applies here, unchanged.
//
// A SECTION IS `null` OR WHOLE. `null` means "not edited: leave every field of
// it as stored"; an object means "this section, exactly as shown". There is no
// per-field "leave it" — an absent field would have to mean either "leave" or
// "clear", and the contract refuses that ambiguity (`edit_identity`'s rule, one
// level up).
//
// WHAT THE COMPOSER NORMALISES, and only when its section was edited — the two
// rules the web's form parser applies (`normalizeDisclose`,
// `normalizeConditionsOther` in `pet-form.ts`), so both doors store the same
// thing for the same intent:
//   · the "otra" description is dropped when "otra" is not a condition;
//   · public disclosure of conditions is off when there are no conditions.
// Running them on an edit that touched NEITHER section would let an identity
// save rewrite a disclosure flag the person never looked at.
//
// AND ONE RULE OF ITS OWN: a condition code the animal ALREADY carries survives
// even when the catalog no longer names it, while a code that is neither in the
// catalog nor on the animal is dropped. The web's parser drops both; dropping a
// stored medical fact because a catalog entry was renamed is the quiet data loss
// `composePetIdentityEdit` exists to prevent, so this door keeps it.

import {
  type PermanentCondition,
  type PetAge,
  type TrainingLevel,
  estimatedBirthDateFromAge,
  isPermanentCondition,
  petAgeFromBirthDate,
} from "@dim/contract/reference";

import type { ParsedPet } from "./types";

/**
 * Everything about the animal that an edit must PRESERVE, plus what it may
 * replace.
 *
 * Structural rather than the Drizzle `Pet` type, for the reason `pet-diff.ts`
 * gives for its own snapshot: the domain layer stays free of `@/db`, and a real
 * `pets` row satisfies this shape as-is.
 */
export type EditablePetSnapshot = {
  name: string;
  species: string;
  sex: "male" | "female" | "unknown";
  breed: string | null;
  dateOfBirth: string | null;
  birthDateIsEstimated: boolean;
  color: string | null;
  estimatedWeightKg: string | null;
  favouriteFoods: string[] | null;
  knownAllergies: string[] | null;
  trainingLevel: TrainingLevel | null;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  acquisitionMethod: ParsedPet["acquisitionMethod"];
  emergencyInfoVisible: boolean;
  permanentConditions: string[];
  permanentConditionsOther: string | null;
  discloseConditionsPublicly: boolean;
};

/** A birth date as stored: the date, and whether it was estimated from an age. */
export type StoredBirthDate = {
  dateOfBirth: string | null;
  birthDateIsEstimated: boolean;
};

/**
 * Identidad. The breed arrives already resolved against the PERSISTED species'
 * catalog, and the birth date already resolved by `resolveEditedBirthDate` —
 * both need the row or a clock, and this composer is pure.
 */
export type PetProfileIdentityEdit = StoredBirthDate & {
  name: string;
  breed: string | null;
  color: string | null;
  sex: "male" | "female" | "unknown";
};

/** Salud y cuidados. */
export type PetProfileHealthEdit = {
  favouriteFoods: string[];
  knownAllergies: string[];
  trainingLevel: TrainingLevel | null;
  permanentConditions: string[];
  permanentConditionsOther: string | null;
};

/** Qué muestra la credencial pública — the two toggles that change what others see. */
export type PetProfilePublicCredentialEdit = {
  emergencyInfoVisible: boolean;
  discloseConditionsPublicly: boolean;
};

/** Seguro. */
export type PetProfileInsuranceEdit = {
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
};

/** Origen. */
export type PetProfileOriginEdit = {
  acquisitionMethod: ParsedPet["acquisitionMethod"];
};

/** One save of "Editar datos": each section `null` (leave it) or whole. */
export type PetProfileEdit = {
  identity: PetProfileIdentityEdit | null;
  health: PetProfileHealthEdit | null;
  publicCredential: PetProfilePublicCredentialEdit | null;
  insurance: PetProfileInsuranceEdit | null;
  origin: PetProfileOriginEdit | null;
};

/** One day, for the tolerance window below. */
const DAY_MS = 24 * 60 * 60 * 1000;

function totalMonths(age: PetAge): number {
  return (age.years ?? 0) * 12 + (age.months ?? 0);
}

/**
 * The birth date an EDIT stores, given the age the form posted.
 *
 * A form shows the stored date as an age and posts the age back, so an age
 * equal to the one the stored date reads as is the person NOT having touched it
 * — the stored date, recorded or estimated, is kept exactly. Before this
 * existed, every save turned the shown age back into "today minus N months":
 * the date drifted on each save and a recorded date became an estimate.
 *
 * "EQUAL" IS CHECKED ON YESTERDAY, TODAY AND TOMORROW, Argentina's calendar.
 * The age a form showed was computed when it OPENED, possibly before midnight,
 * and by a client whose calendar may sit a day off Argentina's; on the one day
 * a month the stored date crosses a month boundary, the shown age and the
 * server's can differ by one month without anybody having changed anything. The
 * window cannot hide a real edit by more than that day: an age typed within it
 * is an age the stored date itself reads as within a day.
 *
 * Both fields blank clears the date, which is what the web form has always done
 * with an emptied age. Any other age is a new estimate, flagged as one.
 */
export function resolveEditedBirthDate(input: {
  stored: StoredBirthDate;
  submitted: PetAge;
  now: Date;
}): StoredBirthDate {
  const { stored, submitted, now } = input;
  if (submitted.years === null && submitted.months === null) {
    return { dateOfBirth: null, birthDateIsEstimated: false };
  }
  if (stored.dateOfBirth !== null) {
    const asked = totalMonths(submitted);
    for (const offset of [-DAY_MS, 0, DAY_MS]) {
      const shown = petAgeFromBirthDate(stored.dateOfBirth, new Date(now.getTime() + offset));
      // A FRESH object with the two fields, never `stored` itself: callers hand
      // in the whole pet row (it fits the type structurally) and spread the
      // answer into an edit, so returning `stored` would spread the row's stored
      // name and colour over the ones the person just typed.
      if (shown.years !== null && totalMonths(shown) === asked) {
        return {
          dateOfBirth: stored.dateOfBirth,
          birthDateIsEstimated: stored.birthDateIsEstimated,
        };
      }
    }
  }
  return {
    dateOfBirth: estimatedBirthDateFromAge(submitted, now),
    birthDateIsEstimated: true,
  };
}

/**
 * The codes a health save stores: the catalog's, plus any the animal already
 * carries. See the header for why a stored legacy code is kept.
 */
function keptConditionCodes(submitted: string[], stored: string[]): string[] {
  return submitted.filter((code) => isPermanentCondition(code) || stored.includes(code));
}

/** The four condition fields after a save, normalised the way the web parser does. */
function composeConditions(
  existing: EditablePetSnapshot,
  edit: PetProfileEdit,
): Pick<ParsedPet, "permanentConditionsOther" | "discloseConditionsPublicly"> & {
  permanentConditions: string[];
} {
  const health = edit.health;
  let conditions = existing.permanentConditions;
  let conditionsOther = existing.permanentConditionsOther;
  if (health) {
    conditions = keptConditionCodes(health.permanentConditions, existing.permanentConditions);
    conditionsOther = conditions.includes("otra") ? health.permanentConditionsOther : null;
  }
  const discloseAsked =
    edit.publicCredential?.discloseConditionsPublicly ?? existing.discloseConditionsPublicly;
  const touched = health !== null || edit.publicCredential !== null;
  return {
    permanentConditions: conditions,
    permanentConditionsOther: conditionsOther,
    discloseConditionsPublicly: touched ? discloseAsked && conditions.length > 0 : discloseAsked,
  };
}

/**
 * Overlay a sectioned edit on the animal's current state. Pure.
 *
 * `permanentConditions` is narrowed by a cast rather than re-validated, for the
 * reason `composePetIdentityEdit` gives: the codes either came out of the column
 * or were filtered against the catalog above, and the one cross-field rule is
 * guarded by `pets_permanent_conditions_other_ck`.
 */
export function composePetProfileEdit(
  existing: EditablePetSnapshot,
  edit: PetProfileEdit,
): ParsedPet {
  const identity = edit.identity;
  const health = edit.health;
  const conditions = composeConditions(existing, edit);
  return {
    name: identity ? identity.name : existing.name,
    breed: identity ? identity.breed : existing.breed,
    color: identity ? identity.color : existing.color,
    sex: identity ? identity.sex : existing.sex,
    dateOfBirth: identity ? identity.dateOfBirth : existing.dateOfBirth,
    birthDateIsEstimated: identity ? identity.birthDateIsEstimated : existing.birthDateIsEstimated,

    favouriteFoods: health ? health.favouriteFoods : (existing.favouriteFoods ?? []),
    knownAllergies: health ? health.knownAllergies : (existing.knownAllergies ?? []),
    trainingLevel: health ? health.trainingLevel : existing.trainingLevel,
    permanentConditions: conditions.permanentConditions as PermanentCondition[],
    permanentConditionsOther: conditions.permanentConditionsOther,
    discloseConditionsPublicly: conditions.discloseConditionsPublicly,

    emergencyInfoVisible: edit.publicCredential
      ? edit.publicCredential.emergencyInfoVisible
      : existing.emergencyInfoVisible,
    insuranceCompany: edit.insurance ? edit.insurance.insuranceCompany : existing.insuranceCompany,
    insurancePolicyNumber: edit.insurance
      ? edit.insurance.insurancePolicyNumber
      : existing.insurancePolicyNumber,
    acquisitionMethod: edit.origin ? edit.origin.acquisitionMethod : existing.acquisitionMethod,

    // Never this door's to write — see `pet-identity-edit.ts`'s header.
    species: existing.species,
    estimatedWeightKg: existing.estimatedWeightKg,
    jurisdictionProvince: existing.jurisdictionProvince,
    jurisdictionLocality: existing.jurisdictionLocality,
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    custodyKind: "owner",
  };
}
