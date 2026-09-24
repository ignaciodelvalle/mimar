// Pure business rules for decomiso (Ley 14.346) domain.
// No IO, no DB, no framework. Deterministic functions only.

import type { SeizureMotive, UnownedAnimalInput } from "./types";
import { ALLOWED_SPECIES, MAX_ATTACHMENT_BYTES } from "./types";

/**
 * Returns a human-readable label for a SeizureMotive value.
 */
export function motiveLabel(motive: SeizureMotive): string {
  switch (motive) {
    case "maltrato_fisico":
      return "Maltrato físico";
    case "abandono_extremo":
      return "Abandono extremo";
    case "acumulacion":
      return "Acumulación";
    case "trafico":
      return "Tráfico";
    case "sin_refugio_critico":
      return "Sin refugio crítico";
    case "pelea_de_perros":
      return "Pelea de perros";
    case "otro":
      return "Otro";
  }
}

/** Validate seizure motive (DC5: otro requires detail). */
export function validateSeizureMotive(
  motive: SeizureMotive,
  otherDetail?: string | null,
): string | null {
  if (motive === "otro" && !otherDetail?.trim()) {
    return "El motivo 'Otro' requiere un detalle explicativo.";
  }
  return null;
}

/** Validate attachment files (DC5: min 2; each within the evidence bucket's 10 MB). */
export function validateAttachments(files: File[]): string | null {
  if (files.length < 2) {
    return "Mínimo 2 adjuntos requeridos: foto del animal + acta administrativa.";
  }
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return `El archivo "${file.name}" supera el límite de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`;
    }
  }
  return null;
}

/** Validate unowned animal input (DC3). */
export function validateUnownedAnimal(input: UnownedAnimalInput): string | null {
  if (!input.species?.trim()) {
    return "Indicá al menos la especie del animal sin registrar.";
  }
  // W3: Server-side species allowlist.
  if (!ALLOWED_SPECIES.includes(input.species.trim())) {
    return "Especie no válida. Las opciones son: perro, gato u otro.";
  }
  // W4: Server-side upper bound on approxAgeMonths.
  if (input.approxAgeMonths != null && input.approxAgeMonths > 360) {
    return "La edad aproximada no puede superar los 360 meses (30 años).";
  }
  return null;
}

/** Validate receiver org for execute / reassign. */
export function validateReceiverOrg(
  org:
    | {
        id: string;
        verified: boolean | null;
        status: string;
        orgType: string;
      }
    | null
    | undefined,
  govtOrgId: string,
): string | null {
  if (!org) return "Organización destinataria no encontrada.";
  if (!org.verified || org.status !== "active") {
    return "La organización destinataria no está verificada o activa.";
  }
  if (!["shelter", "rescue_network"].includes(org.orgType)) {
    return "La organización destinataria debe ser un refugio (shelter) o red de rescate (rescue_network).";
  }
  if (org.id === govtOrgId) {
    return "El destinatario no puede ser la propia autoridad sanitaria.";
  }
  return null;
}

/** Compute the synthetic name for an unowned stray. */
export function straySyntheticName(unownedData: UnownedAnimalInput): string {
  const candidate = [unownedData.species, unownedData.breed ?? null, unownedData.color ?? null]
    .filter(Boolean)
    .join(" ")
    .trim();
  return candidate || "Animal sin registrar";
}

// ---------------------------------------------------------------------------
// Seizure addressees
// ---------------------------------------------------------------------------

/** One `ownerships` row, reduced to the two columns that name its holder. */
export type OwnershipHolder = {
  ownerUserId: string | null;
  ownerOrganizationId: string | null;
};

/**
 * Split the ownerships a decomiso terminates into the two addressee shapes the
 * notification fan-out can actually reach.
 *
 * WHY THIS IS A FUNCTION AND NOT A LOOP INSIDE THE TRANSACTION
 * ---------------------------------------------------------------------------
 * executeDecomiso ends EVERY active ownership on the pet, but collected only
 * `ownerUserId` for the notification pass. An `ownerships` row carries either a
 * user or an organization, never both — so an animal held by a refugio, a rescue
 * network or a clinic was seized, its ownership terminated, and NOBODY was told.
 * The bug was invisible from the action's return value, which reports `ok: true`
 * whether it notified three people or none.
 *
 * Pulling the split out here makes "an org-held ownership produces an addressee"
 * a property a test can assert without a database.
 */
export function splitOwnershipAddressees(rows: readonly OwnershipHolder[]): {
  userIds: string[];
  organizationIds: string[];
} {
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  for (const row of rows) {
    if (row.ownerUserId) userIds.push(row.ownerUserId);
    else if (row.ownerOrganizationId) organizationIds.push(row.ownerOrganizationId);
  }
  return { userIds, organizationIds };
}
