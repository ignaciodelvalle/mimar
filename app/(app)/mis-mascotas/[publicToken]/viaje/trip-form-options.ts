// The trip form's chained filters, as plain functions (v14, "Viaje en pasos").
//
// Kept OUT of TripForm.tsx on purpose: that file is "use client", and the
// /viaje page (a server component) needs `isShortcutCorridor` too — a server
// component cannot call a function a client module exports (it would receive
// a client reference, not the function). Contract imports only.

import {
  CORRIDOR_MODES,
  PET_TRAVEL_MODALITY_LABELS,
  type PetTravelAirlineModalityV1,
  type PetTravelAirlineOptionV1,
  type PetTravelModeV1,
} from "@dim/contract/api";
import type { TravelCorridorId } from "@dim/contract/input";

/** The "Otro país" choice: not a destination, never posted as one. */
export const OTHER_COUNTRY = "otro";

/** Where the owner looks for a destination miMAR does not check. */
export const DESTINATION_REQUIREMENTS_URL =
  "https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino";

const ALL_MODES: readonly PetTravelModeV1[] = ["air", "land", "sea"];

/** The modes a destination offers; every mode before one is chosen. */
export function modesFor(corridorId: string): readonly PetTravelModeV1[] {
  return (CORRIDOR_MODES as Record<string, readonly PetTravelModeV1[]>)[corridorId] ?? ALL_MODES;
}

/** Suggested airlines for the destination first, then the rest — never fewer. */
export function airlinesFor(
  airlines: readonly PetTravelAirlineOptionV1[],
  corridorId: string,
  search: string,
): { suggested: PetTravelAirlineOptionV1[]; others: PetTravelAirlineOptionV1[] } {
  const isSuggested = (a: PetTravelAirlineOptionV1) =>
    corridorId !== "" && (a.corridors ?? []).includes(corridorId);
  const needle = search.trim().toLocaleLowerCase("es-AR");
  return {
    suggested: airlines.filter(isSuggested),
    others: airlines.filter(
      (a) =>
        !isSuggested(a) && (needle === "" || a.name.toLocaleLowerCase("es-AR").includes(needle)),
    ),
  };
}

/** "En cabina · hasta 7 kg con el bolso" — what the airline publishes. */
export function modalityOptionLabel(m: PetTravelAirlineModalityV1): string {
  const parts = [PET_TRAVEL_MODALITY_LABELS[m.modality]];
  if (m.maxWeightKg !== null) {
    parts.push(`hasta ${m.maxWeightKg} kg${m.includesCarrier ? " con el bolso o canil" : ""}`);
  }
  if (m.offered === "restricted") parts.push("con restricciones");
  return parts.join(" · ");
}

/** The destination ids a shortcut may preselect. */
export function isShortcutCorridor(value: unknown): value is TravelCorridorId {
  return typeof value === "string" && Object.hasOwn(CORRIDOR_MODES, value);
}
