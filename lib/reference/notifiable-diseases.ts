// The diseases a vet can file as an ENO diagnosis (PO S2, 2026-09-26): every
// catalog disease (diseases.ts) that bridges to the ENO list, for the animal's
// species. Pure data — safe for a client form and for the server's refusal of
// a code the picker never offered.

import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

import { type DiseaseDef, diseasesForSpecies } from "./diseases";

export type NotifiableDiagnosisOption = {
  code: string;
  label: string;
  /** The legal window this diagnosis opens, in hours (the ENO catalog's). */
  notifyHours: number;
};

function toOption(d: DiseaseDef): NotifiableDiagnosisOption | null {
  const eno = getEnoDisease(diseaseCodeToEnoCode(d.code));
  return eno ? { code: d.code, label: d.label, notifyHours: eno.notifyHours } : null;
}

/** The notifiable diseases the picker offers for this species. */
export function notifiableDiagnosisOptions(
  species: string | null | undefined,
): NotifiableDiagnosisOption[] {
  return diseasesForSpecies(species)
    .map(toOption)
    .filter((o): o is NotifiableDiagnosisOption => o !== null);
}

/** True when `code` is a catalog disease that opens an ENO notice. */
export function isNotifiableDiagnosisCode(code: string): boolean {
  return getEnoDisease(diseaseCodeToEnoCode(code)) !== null;
}
