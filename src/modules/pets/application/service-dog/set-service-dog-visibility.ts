// Use-case: setServiceDogVisibility (strangler migration 14/61).
//
// Auth guard lifted into the shim (app/actions/service-dog.ts); the use-case
// receives the authenticated userId + inputs and runs the rest verbatim.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { type ServiceDogVisibility, db, petServiceDog } from "@/db";

import { loadOwnedPetWithServiceDog } from "./helpers";

export async function setServiceDogVisibility(
  userId: string,
  input: {
    petPublicToken: string;
    publicVisibility: ServiceDogVisibility;
  },
): Promise<{ ok: true } | { error: string }> {
  const target = await loadOwnedPetWithServiceDog(userId, input.petPublicToken);
  if (!target || !target.serviceDog) {
    return { error: "Credencial no encontrada." };
  }

  await db
    .update(petServiceDog)
    .set({ publicVisibility: input.publicVisibility, updatedAt: new Date() })
    .where(eq(petServiceDog.id, target.serviceDog.id));

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/asistencia`);
  revalidatePath(`/p/${input.petPublicToken}`);
  return { ok: true };
}
