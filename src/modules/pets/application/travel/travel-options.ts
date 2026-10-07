// What the record-trip form offers (v14, "Viaje en pasos"): the destinations
// with their paper and deadlines, and the airlines with the destinations they
// are suggested for and the modalities they publish.
//
// ONE BUILDER for both surfaces. `GET /api/v1/pets/{publicToken}/travel` puts
// these in `options` for the native screen, and the /viaje page hands the same
// objects to TripForm, so the web and the phone filter the same lists the same
// way. The shapes are the contract's (`PetTravelCorridorOptionV1`,
// `PetTravelAirlineOptionV1`).
//
// Nothing here reads the animal: the deadlines are the destination's rules,
// never a verdict, and the airline suggestions are an ORDER, never a rule.

import { AIRLINES, type Airline } from "@/lib/reference/airlines";
import {
  CORRIDORS,
  type Corridor,
  corridorLeadDays,
  corridorLeadHints,
} from "@/lib/reference/cross-border-corridors";
import type {
  PetTravelAirlineModalityV1,
  PetTravelAirlineOptionV1,
  PetTravelCorridorOptionV1,
} from "@dim/contract/api";

/** A destination as the form offers it: its paper and its deadlines. */
export function toCorridorOption(corridor: Corridor): PetTravelCorridorOptionV1 {
  return {
    id: corridor.id,
    label: corridor.label,
    paper: { ...corridor.paper },
    leadHints: corridorLeadHints(corridor),
    leadDays: corridorLeadDays(corridor),
  };
}

const MODALITY_ORDER = ["cabin", "hold", "cargo"] as const;

/**
 * An airline as the form offers it: the destinations it is suggested for, and
 * the modalities it publishes as offered (anything but "no").
 */
export function toAirlineOption(airline: Airline): PetTravelAirlineOptionV1 {
  const modalities: PetTravelAirlineModalityV1[] = [];
  for (const modality of MODALITY_ORDER) {
    const row = airline.modalities[modality];
    if (!row || row.offered.value === "no") continue;
    modalities.push({
      modality,
      offered: row.offered.value,
      maxWeightKg: row.maxWeightKg?.value.kg ?? null,
      includesCarrier: row.maxWeightKg?.value.includesCarrier ?? false,
    });
  }
  return {
    id: airline.id,
    name: airline.name,
    corridors: [...airline.servesCorridors],
    modalities,
  };
}

/** Every destination and every airline, as the form offers them. */
export function travelFormOptions(): {
  corridors: PetTravelCorridorOptionV1[];
  airlines: PetTravelAirlineOptionV1[];
} {
  return {
    corridors: CORRIDORS.map(toCorridorOption),
    airlines: AIRLINES.map(toAirlineOption),
  };
}
