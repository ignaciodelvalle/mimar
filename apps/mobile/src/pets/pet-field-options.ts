// The words for two of an animal's facts — its sex and how it came home — as
// the app's choosers show them.
//
// ONE COPY FOR THE ALTA AND THE EDIT (owner-pet-actions, 2026-10-01). These two
// lists lived inside `AltaScreen.tsx` while the alta was the only screen that
// asked. "Editar datos" now asks the same two questions, and a second copy of
// the labels is how "La encontré" on one screen becomes "Encontrado/a en la
// calle" on the other. The VALUES are the contract's (`PET_SEXES`,
// `ACQUISITION_METHODS`); the words are this app's, first person, as the alta
// has always said them.
//
// THE LABEL TABLES ARE EXHAUSTIVE RECORDS, so a value the contract adds is a
// compile error here rather than a chip with no words on it.
//
// PURE. No React — the edit view-model reads these to label its choices.

import type { AcquisitionMethod, PetSex } from "@dim/contract/input";

const SEX_LABELS: Readonly<Record<PetSex, string>> = {
  female: "Hembra",
  male: "Macho",
  unknown: "No sé",
};

const ACQUISITION_LABELS: Readonly<Record<AcquisitionMethod, string>> = {
  adopted: "Adopción",
  purchased: "Compra",
  found_stray: "La encontré",
  gift: "Regalo",
  born_in_litter: "Nació en casa",
  other: "Otro",
};

/** The chooser's order: the two answers most people have, then "No sé". */
const SEX_ORDER: readonly PetSex[] = ["female", "male", "unknown"];

export const SEX_OPTIONS: readonly { value: PetSex; label: string }[] = SEX_ORDER.map((value) => ({
  value,
  label: SEX_LABELS[value],
}));

export const ACQUISITION_ORDER: readonly AcquisitionMethod[] = [
  "adopted",
  "purchased",
  "found_stray",
  "gift",
  "born_in_litter",
  "other",
];

export const ACQUISITION_OPTIONS: readonly { value: AcquisitionMethod; label: string }[] =
  ACQUISITION_ORDER.map((value) => ({ value, label: ACQUISITION_LABELS[value] }));

export function petSexLabel(sex: PetSex): string {
  return SEX_LABELS[sex];
}

export function acquisitionMethodLabel(method: AcquisitionMethod): string {
  return ACQUISITION_LABELS[method];
}
