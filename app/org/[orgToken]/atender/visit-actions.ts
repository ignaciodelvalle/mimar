"use server";

// Atender — start and end an atención (vet-visit-record, 2026-09-29).
//
// Neither action writes an event: a visit is operational metadata (invariant
// 3), the grouping of what one signer did for one pet in one sitting. The
// clinical writers in ./actions.ts open a visit on their own when none is open
// (care is never refused for want of one); these two exist so the vet can say
// WHERE the care happens — en la clínica o a domicilio — and link the
// appointment being attended, before the first record, and can end the
// sitting when it ends.
//
// Auth: resolveAtenderPet, the same boundary every walk-in writer passes.

import { revalidatePath } from "next/cache";

import type { EventFormState } from "@/src/modules/events/actions";
import { isVisitModality } from "@/src/modules/visits/domain/types";
import { closeVisitOfPet } from "@/src/modules/visits/infrastructure/visit-service";

import { resolveAtenderPet } from "./atender-access";
import { openAtenderVisit } from "./atender-visit";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Iniciar atención": open (or reuse) the signer's visit with a chosen modality. */
export async function atenderStartVisitAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };

  const modality = String(formData.get("modality") ?? "").trim();
  if (!isVisitModality(modality)) {
    return { error: "Elegí dónde es la atención: en la clínica o a domicilio." };
  }
  const appointmentRaw = String(formData.get("appointmentId") ?? "").trim();
  if (appointmentRaw && !UUID_PATTERN.test(appointmentRaw)) {
    return { error: "El turno elegido no es válido." };
  }

  let opened: Awaited<ReturnType<typeof openAtenderVisit>>;
  try {
    opened = await openAtenderVisit(access, {
      modality,
      appointmentId: appointmentRaw || null,
    });
  } catch {
    // A DB error here (connection, constraint) must read as a sentence, not
    // crash the server action with an unhandled error page (suggestion,
    // vet-visit-record verify report).
    return { error: "No se pudo iniciar la atención." };
  }
  if (!opened.ok) {
    return {
      error:
        opened.reason === "foreign_appointment"
          ? "Ese turno no es de esta mascota en esta organización."
          : "No se pudo iniciar la atención.",
    };
  }

  revalidatePath(`/org/${orgToken}/atender/${access.pet.publicToken}`);
  return { error: null, ok: true };
}

/**
 * "Terminar atención". `visitId` is a BOUND argument, never a form field, and
 * it must name a visit of THIS pet at THIS organization — anything else reads
 * as not found. Closing is further restricted to the visit's OWN vet or an
 * org admin (W4): any other org member is refused and the visit stays open.
 * Closing twice is a no-op.
 */
export async function atenderCloseVisitAction(
  orgToken: string,
  publicToken: string,
  visitId: string,
  _previous: EventFormState,
  _formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  if (!UUID_PATTERN.test(visitId)) return { error: "No encontramos esa atención." };

  const closed = await closeVisitOfPet({
    visitId,
    petId: access.pet.id,
    organizationId: access.organizationId,
    actorUserId: access.user.id,
    isOrgAdmin: access.isOrgAdmin,
  });
  if (!closed.ok) {
    return {
      error:
        closed.reason === "not_authorized"
          ? "Solo quien atendió esta visita, o un administrador de la organización, puede cerrarla."
          : "No encontramos esa atención.",
    };
  }

  revalidatePath(`/org/${orgToken}/atender/${access.pet.publicToken}`);
  return { error: null, ok: true };
}
