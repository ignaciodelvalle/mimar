// Pure-logic module for service-dog label lookups.
//
// Extracted from ServiceDogCredentialCard.tsx so the label map can be tested
// without a JSX runtime. The component imports from here.
//
// Keys MUST match SERVICE_DOG_TYPES in db/schema.ts exactly.
// ServiceDogCredentialCard.test.ts guards this contract.

import type { ServiceDogType } from "@/db/schema";

export const SERVICE_TYPE_LABELS: Record<ServiceDogType, string> = {
  guia: "Perro guía",
  asistencia_motriz: "Perro de asistencia motriz",
  alerta_medica: "Perro de alerta médica",
  senal_auditiva: "Perro señal auditiva",
  asistencia_tea: "Perro de asistencia TEA",
  otro: "Otro tipo de perro de servicio",
};

/**
 * Builds the href for the "Presentar credencial" footer link in
 * ServiceDogCredentialCard. Extracted so it can be unit-tested without JSX.
 */
export function buildPresentarHref(petPublicToken: string): string {
  return `/mis-mascotas/${petPublicToken}/asistencia/presentar`;
}
