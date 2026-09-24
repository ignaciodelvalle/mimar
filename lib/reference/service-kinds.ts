// Catalog of service kinds supported by the scheduling system. Each entry
// maps to the pet_event type emitted on attendance. New kinds added here;
// the emitted_event_type binds the lifecycle to the libreta sanitaria
// constants.

import type { EventType } from "@/db/schema";

export type ServiceKindDef = {
  code: string;
  label: string; // es-AR display label
  emitted_event_type: EventType; // pet_event type emitted on attendance
  default_duration_minutes: number;
  default_eligibility_species?: ("dog" | "cat")[];
};

export const SERVICE_KINDS: readonly ServiceKindDef[] = [
  {
    code: "vaccination_rabies",
    label: "Vacunación antirrábica",
    emitted_event_type: "vaccination_administered",
    default_duration_minutes: 15,
    default_eligibility_species: ["dog", "cat"],
  },
  {
    code: "vaccination_triple_canina",
    label: "Vacuna triple canina",
    emitted_event_type: "vaccination_administered",
    default_duration_minutes: 15,
    default_eligibility_species: ["dog"],
  },
  {
    code: "vaccination_triple_felina",
    label: "Vacuna triple felina",
    emitted_event_type: "vaccination_administered",
    default_duration_minutes: 15,
    default_eligibility_species: ["cat"],
  },
  {
    code: "sterilization_dog_male",
    label: "Castración perro macho",
    emitted_event_type: "sterilization_performed",
    default_duration_minutes: 60,
    default_eligibility_species: ["dog"],
  },
  {
    code: "sterilization_dog_female",
    label: "Ovariectomía perra",
    emitted_event_type: "sterilization_performed",
    default_duration_minutes: 90,
    default_eligibility_species: ["dog"],
  },
  {
    code: "sterilization_cat_male",
    label: "Castración gato macho",
    emitted_event_type: "sterilization_performed",
    default_duration_minutes: 45,
    default_eligibility_species: ["cat"],
  },
  {
    code: "sterilization_cat_female",
    label: "Ovariectomía gata",
    emitted_event_type: "sterilization_performed",
    default_duration_minutes: 60,
    default_eligibility_species: ["cat"],
  },
  {
    code: "deworming",
    label: "Desparasitación",
    emitted_event_type: "deworming_administered",
    default_duration_minutes: 10,
    default_eligibility_species: ["dog", "cat"],
  },
  {
    code: "general_checkup",
    label: "Consulta general",
    emitted_event_type: "vet_visit_logged",
    default_duration_minutes: 30,
    default_eligibility_species: ["dog", "cat"],
  },
  {
    code: "microchip_implantation",
    label: "Colocación de microchip",
    emitted_event_type: "microchip_implanted",
    default_duration_minutes: 15,
    default_eligibility_species: ["dog", "cat"],
  },
] as const;

export function findServiceKind(code: string): ServiceKindDef | null {
  return SERVICE_KINDS.find((s) => s.code === code) ?? null;
}
