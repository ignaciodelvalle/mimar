// Use-case: upsertServiceDog — service-dog credential upsert (strangler migration 14/61).
//
// Auth guard lifted into the shim (app/actions/service-dog.ts); the use-case
// receives the authenticated userId + inputs and runs the rest verbatim.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { type ServiceDogStatus, db, petServiceDog } from "@/db";

import { loadOwnedPetWithServiceDog } from "./helpers";
import type { UpsertServiceDogInput, UpsertServiceDogResult } from "./types";

export async function upsertServiceDog(
  userId: string,
  input: UpsertServiceDogInput,
): Promise<UpsertServiceDogResult> {
  if (!input.trainingCenter.trim()) {
    return { error: "Indicá el centro de entrenamiento." };
  }

  const target = await loadOwnedPetWithServiceDog(userId, input.petPublicToken);
  if (!target) return { error: "Mascota no encontrada o no sos su dueño/a." };

  // Ley 26.858 is dog-specific. Guard at the action so the form can show a
  // clear message; the public banner would skip non-dogs anyway.
  if (target.pet.species !== "dog") {
    return {
      error: "El reconocimiento legal del Art. 1, Ley 26.858 aplica solo a perros.",
    };
  }

  const now = new Date();
  const status: ServiceDogStatus = "pendiente_verificacion";

  try {
    if (target.serviceDog) {
      // Updating an existing row never bumps to 'vigente'; that lives in
      // the approval flow. If the owner edits while vigente, we keep the
      // current status — admin/govt can re-verify if material data changed.
      await db
        .update(petServiceDog)
        .set({
          serviceType: input.serviceType,
          trainingCenter: input.trainingCenter.trim(),
          trainingCertDate: input.trainingCertDate || null,
          rupgaCredential: input.rupgaCredential?.trim() || null,
          credentialIssueDate: input.credentialIssueDate || null,
          credentialExpiryDate: input.credentialExpiryDate || null,
          notes: input.notes?.trim() || null,
          publicVisibility: input.publicVisibility ?? target.serviceDog.publicVisibility,
          updatedAt: now,
        })
        .where(eq(petServiceDog.id, target.serviceDog.id));
    } else {
      await db.insert(petServiceDog).values({
        petId: target.pet.id,
        serviceType: input.serviceType,
        credentialStatus: status,
        trainingCenter: input.trainingCenter.trim(),
        trainingCertDate: input.trainingCertDate || null,
        rupgaCredential: input.rupgaCredential?.trim() || null,
        credentialIssueDate: input.credentialIssueDate || null,
        credentialExpiryDate: input.credentialExpiryDate || null,
        notes: input.notes?.trim() || null,
        publicVisibility: input.publicVisibility ?? "private_only",
      });
    }
  } catch (err) {
    return {
      error: `No se pudo guardar la credencial: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/asistencia`);
  return { ok: true };
}
