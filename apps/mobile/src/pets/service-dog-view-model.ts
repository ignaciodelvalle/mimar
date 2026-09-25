// PERRO DE ASISTENCIA — the pure half of `ServiceDogScreen` (D3, 2026-09-25).
//
// EVERYTHING HERE IS TRANSCRIBED FROM THE WEB, not designed again: the labels
// are `ServiceDogForm.tsx`'s `SERVICE_TYPE_OPTIONS` and `AsistenciaPage`'s
// `STATUS_LABELS`, and WHICH act the screen offers in WHICH state is the form's
// own set of conditions (`canSubmitVerification`, `isVigente && inService`,
// `inService`, `isRevoked`). The server enforces who may act at all
// (`canManageServiceDog`) and its use-cases refuse a stale act; this file only
// keeps the screen from offering what the web would not.

import type {
  PetProfileEditAckV1,
  PetProfileEditV1,
  ServiceDogDesignationV1,
} from "@dim/contract/api";
import {
  SERVICE_DOG_TYPES,
  type ServiceDogStatusV1,
  type ServiceDogTypeV1,
} from "@dim/contract/input";

import { dateInputToIso, isoToDateInput } from "../ui/date-input";
import { type CommandResult, validated } from "./pet-profile-edit-view-model";

/** The web form's option labels, verbatim. */
const SERVICE_TYPE_LABELS: Record<ServiceDogTypeV1, string> = {
  guia: "Guía (discapacidad visual)",
  asistencia_motriz: "Asistencia motriz",
  alerta_medica: "Alerta médica (diabetes, epilepsia)",
  senal_auditiva: "Señal (auditiva)",
  asistencia_tea: "Asistencia TEA (autismo)",
  otro: "Otro (no enumerado por ANDIS — sin banner público)",
};

export const SERVICE_DOG_TYPE_OPTIONS: readonly ServiceDogTypeV1[] = SERVICE_DOG_TYPES;

export function serviceDogTypeLabel(type: ServiceDogTypeV1): string {
  return SERVICE_TYPE_LABELS[type];
}

/** `AsistenciaPage`'s `STATUS_LABELS`, verbatim. */
const STATUS_LABELS: Record<ServiceDogStatusV1, string> = {
  en_entrenamiento: "En entrenamiento",
  pendiente_verificacion: "Pendiente de verificación",
  vigente: "Vigente",
  vencida: "Vencida",
  revocada: "Revocada",
};

export function serviceDogStatusLabel(status: ServiceDogStatusV1): string {
  return STATUS_LABELS[status];
}

/**
 * The one-line summary the web's "Estado de la credencial" card opens with:
 * in service or retired, and whether the public banner is on.
 */
export function serviceDogSummary(designation: ServiceDogDesignationV1): string {
  const service = designation.inService ? "En servicio activo." : "Retirado del servicio.";
  const banner = designation.publicVisibility === "full_banner" ? "activada" : "solo privado";
  return `${service} Visibilidad pública: ${banner}.`;
}

/**
 * The explanation under the status, per state — the web card's own sentences.
 * `null` for a state the web says nothing more about.
 */
export function serviceDogStatusExplanation(designation: ServiceDogDesignationV1): string | null {
  switch (designation.credentialStatus) {
    case "pendiente_verificacion":
      return "Reportado a RUPGA (ANDIS) — pendiente de sincronización y validación por la autoridad. La credencial no puede presentarse como vigente hasta que ANDIS la valide.";
    case "en_entrenamiento":
      return "En entrenamiento. Una vez finalizado, enviá la solicitud de verificación para que RUPGA (ANDIS) valide la credencial.";
    case "vigente":
      return "Tu banner público está activo cuando elegís mostrarlo. Lo podés presentar en la puerta de un local, transporte o servicio público.";
    case "revocada":
      return designation.revocationReason
        ? `Motivo de revocación: ${designation.revocationReason}`
        : null;
    case "vencida":
      return null;
  }
}

/** Which acts the screen offers — `ServiceDogForm`'s own conditions. */
export type ServiceDogActions = {
  /** The form is read-only once revoked (`<fieldset disabled={isRevoked}>`). */
  canSave: boolean;
  /** "Solicitar verificación": en entrenamiento or pendiente de verificación. */
  canRequestVerification: boolean;
  /** The banner switch: vigente AND in service. */
  canToggleVisibility: boolean;
  /** "Retirar del servicio": while in service. */
  canRetire: boolean;
};

export function serviceDogActions(designation: ServiceDogDesignationV1 | null): ServiceDogActions {
  if (designation === null) {
    return {
      canSave: true,
      canRequestVerification: false,
      canToggleVisibility: false,
      canRetire: false,
    };
  }
  const status = designation.credentialStatus;
  return {
    canSave: status !== "revocada",
    canRequestVerification: status === "en_entrenamiento" || status === "pendiente_verificacion",
    canToggleVisibility: status === "vigente" && designation.inService,
    canRetire: designation.inService,
  };
}

/** The form's fields as a `TextInput` holds them — dates as `DD/MM/AAAA`. */
export type ServiceDogDraft = {
  serviceType: ServiceDogTypeV1;
  trainingCenter: string;
  trainingCertDate: string;
  rupgaCredential: string;
  credentialIssueDate: string;
  credentialExpiryDate: string;
  notes: string;
};

/** Pre-fill: the stored row, or the web form's defaults (`guia`, all empty). */
export function serviceDogDraftFrom(designation: ServiceDogDesignationV1 | null): ServiceDogDraft {
  return {
    serviceType: designation?.serviceType ?? "guia",
    trainingCenter: designation?.trainingCenter ?? "",
    trainingCertDate: isoToDateInput(designation?.trainingCertDate ?? ""),
    rupgaCredential: designation?.rupgaCredential ?? "",
    credentialIssueDate: isoToDateInput(designation?.credentialIssueDate ?? ""),
    credentialExpiryDate: isoToDateInput(designation?.credentialExpiryDate ?? ""),
    notes: designation?.notes ?? "",
  };
}

/**
 * GUARDAR DATOS. Empty fields travel as `null`, which the use-case stores as
 * `null` — the web form's own `value || null`, so clearing a field clears it.
 */
export function buildSaveServiceDog(draft: ServiceDogDraft): CommandResult {
  return validated({
    command: "save_service_dog",
    serviceType: draft.serviceType,
    trainingCenter: draft.trainingCenter,
    trainingCertDate: dateInputToIso(draft.trainingCertDate) || null,
    rupgaCredential: draft.rupgaCredential.trim() || null,
    credentialIssueDate: dateInputToIso(draft.credentialIssueDate) || null,
    credentialExpiryDate: dateInputToIso(draft.credentialExpiryDate) || null,
    notes: draft.notes.trim() || null,
  });
}

/** The sentence after one of the four acts lands. `null` for an ack of another command. */
export function serviceDogSavedLabel(ack: PetProfileEditAckV1): string | null {
  switch (ack.command) {
    case "save_service_dog":
      return "Datos guardados.";
    case "request_service_dog_verification":
      // The web form's own sentence, token included.
      return `Solicitud enviada (${ack.approvalRequestPublicToken}). La autoridad va a revisarla.`;
    case "set_service_dog_visibility":
      return "Listo. Actualizamos la visibilidad del banner.";
    case "retire_service_dog":
      return "Listo. El perro quedó retirado del servicio.";
    default:
      return null;
  }
}

/** What the screen renders, derived from the GET once. */
export type ServiceDogScreenView =
  | { kind: "forbidden" }
  | { kind: "not_a_dog"; petName: string }
  | { kind: "ready"; petName: string; designation: ServiceDogDesignationV1 | null };

export function serviceDogScreenView(payload: PetProfileEditV1): ServiceDogScreenView {
  if (!payload.capabilities.canManageServiceDog || payload.serviceDog === null) {
    return { kind: "forbidden" };
  }
  // The web page shows the form to dogs only and a Ley 26.858 notice to the
  // rest; the upsert use-case refuses a non-dog on its own as well.
  if (payload.species !== "dog") return { kind: "not_a_dog", petName: payload.identity.name };
  return {
    kind: "ready",
    petName: payload.identity.name,
    designation: payload.serviceDog.designation,
  };
}
