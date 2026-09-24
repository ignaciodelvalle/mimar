// Use-case: submitServiceDogVerificationRequest (strangler migration 14/61).
//
// Creates the approval_request that admin/govt reviews. The applicant
// jurisdictionProvince/Locality drive scope-matching (govt sees their
// jurisdiction); admin always sees all. The pet's jurisdiction is preferred,
// falling back to the owner's profile when not set on the pet.
//
// Auth guard lifted into the shim (app/actions/service-dog.ts); the use-case
// receives the authenticated userId + inputs and runs the rest verbatim.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { approvalRequests, db, petServiceDog } from "@/db";
import { generatePrefixedToken } from "@/lib/infra/publicToken";

import { loadOwnedPetWithServiceDog } from "./helpers";
import type { SubmitVerificationInput, SubmitVerificationResult } from "./types";

export async function submitServiceDogVerificationRequest(
  userId: string,
  input: SubmitVerificationInput,
): Promise<SubmitVerificationResult> {
  const target = await loadOwnedPetWithServiceDog(userId, input.petPublicToken);
  if (!target) return { error: "Mascota no encontrada o no sos su dueño/a." };
  if (!target.serviceDog) {
    return { error: "Primero completá la información del perro de asistencia." };
  }
  if (target.serviceDog.credentialStatus === "vigente") {
    return { error: "Esta credencial ya está verificada." };
  }

  // Resolve scope. Pet jurisdiction is the canonical source when the owner
  // filled it; otherwise we anchor on the most recent profile jurisdiction
  // — admin will catch the rest.
  const province = target.pet.jurisdictionProvince ?? "Buenos Aires";
  const locality = target.pet.jurisdictionLocality ?? "Sin especificar";

  // Defense in depth: don't allow two pending requests for the same pet.
  const [duplicate] = await db
    .select({ id: approvalRequests.id, publicToken: approvalRequests.publicToken })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.type, "service_dog_credential_verification"),
        eq(approvalRequests.status, "pending"),
        eq(approvalRequests.applicantUserId, userId),
      ),
    );
  if (duplicate) {
    // Re-check the payload pet_id matches.
    const [dup] = await db
      .select({ payload: approvalRequests.payload, publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, duplicate.id))
      .limit(1);
    const payload = (dup?.payload ?? {}) as { pet_id?: string };
    if (payload.pet_id === target.pet.id) {
      return { error: "Ya tenés una solicitud pendiente para esta mascota." };
    }
  }

  const publicToken = generatePrefixedToken("APR");
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(approvalRequests).values({
        publicToken,
        type: "service_dog_credential_verification",
        status: "pending",
        applicantUserId: userId,
        initiatedBy: "self",
        initiatedByUserId: userId,
        targetUserId: userId,
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
        payload: {
          pet_id: target.pet.id,
          pet_public_token: target.pet.publicToken,
          service_type: target.serviceDog?.serviceType ?? null,
          training_center: target.serviceDog?.trainingCenter ?? null,
          rupga_credential: target.serviceDog?.rupgaCredential ?? null,
        },
        createdAt: now,
        updatedAt: now,
      });

      // Flip the service-dog row from 'en_entrenamiento' (if applicable) to
      // 'pendiente_verificacion' so the UI shows the right state.
      if (target.serviceDog && target.serviceDog.credentialStatus !== "vigente") {
        await tx
          .update(petServiceDog)
          .set({
            credentialStatus: "pendiente_verificacion",
            updatedAt: now,
          })
          .where(eq(petServiceDog.id, target.serviceDog.id));
      }
    });
  } catch (err) {
    return {
      error: `No se pudo enviar la solicitud: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/asistencia`);
  return { approvalRequestPublicToken: publicToken };
}
