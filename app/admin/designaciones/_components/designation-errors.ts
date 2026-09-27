// What the platform admin reads when appointing or revoking a jurisdiction
// administrator is refused (SDD jurisdiction-admin, Phase 3). Pure, so the
// copy is tested without a browser. Never a raw database message: every
// refusal the database can make is translated first
// (lib/infra/jurisdiction-admin-refusals.ts).

import { JURISDICTION_ADMIN_REFUSAL_COPY } from "@/lib/ui/jurisdiction-admin-copy";

const MESSAGES: Record<string, string> = {
  ...JURISDICTION_ADMIN_REFUSAL_COPY,
  NOT_FOUND: "No encontramos esa persona o esa designación. Recargá la página.",
  ALREADY_REVOKED: "Esa designación ya estaba revocada.",
  UNEXPECTED: "No se pudo guardar el cambio. Probá de nuevo.",
};

export function designationErrorMessage(error: string, provinceName: string): string {
  if (error.startsWith("VALIDATION_ERROR: ")) return error.slice("VALIDATION_ERROR: ".length);
  if (error === "PROVINCE_TAKEN") {
    return `${provinceName} ya tiene un administrador de jurisdicción activo.`;
  }
  return MESSAGES[error] ?? MESSAGES.UNEXPECTED;
}
