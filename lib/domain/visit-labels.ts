// es-AR labels for visits and the "Estado al ingreso" record
// (vet-visit-record, 2026-09-29).
//
// One table per enum, keyed by the enum's own type, so a value added to a
// schema without a label here fails the typecheck instead of printing a raw
// English identifier into a clinical record. Type-only imports: this module is
// safe in client components.

import type {
  INTAKE_GENERAL_CONDITIONS,
  INTAKE_HYDRATION_LEVELS,
  INTAKE_MUCOUS_MEMBRANES,
} from "@/lib/events/event-schemas";

type VisitModality = "clinic" | "home";

/** Where the care happened — visits, service offerings and appointments. */
export const VISIT_MODALITY_LABELS: Record<VisitModality, string> = {
  clinic: "En la clínica",
  home: "A domicilio",
};

export const INTAKE_CONDITION_LABELS: Record<(typeof INTAKE_GENERAL_CONDITIONS)[number], string> = {
  good: "Bueno",
  fair: "Regular",
  poor: "Malo",
  critical: "Crítico",
};

export const INTAKE_HYDRATION_LABELS: Record<(typeof INTAKE_HYDRATION_LEVELS)[number], string> = {
  normal: "Normal",
  mild: "Deshidratación leve",
  moderate: "Deshidratación moderada",
  severe: "Deshidratación grave",
};

export const INTAKE_MUCOUS_LABELS: Record<(typeof INTAKE_MUCOUS_MEMBRANES)[number], string> = {
  pink: "Rosadas",
  pale: "Pálidas",
  cyanotic: "Cianóticas",
  icteric: "Ictéricas",
  hyperemic: "Hiperémicas",
};

/** The label for a stored value, or null for anything the table does not know. */
export function labelOf(table: Record<string, string>, value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(table, value) ? table[value] : null;
}
