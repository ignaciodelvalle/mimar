// Use-case: retireServiceDog (strangler migration 14/61).
//
// Owner-side: marks in_service=false. Retired service dogs lose access
// rights legally (Art. 8 implicit — retirement = no longer "perro de
// asistencia en servicio"). The row stays for historical reference; the
// banner hides automatically.
//
// Auth guard lifted into the shim (app/actions/service-dog.ts); the use-case
// receives the authenticated userId + inputs and runs the rest verbatim.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, petServiceDog } from "@/db";

import { loadOwnedPetWithServiceDog } from "./helpers";

export async function retireServiceDog(
  userId: string,
  input: {
    petPublicToken: string;
  },
): Promise<{ ok: true } | { error: string }> {
  const target = await loadOwnedPetWithServiceDog(userId, input.petPublicToken);
  if (!target || !target.serviceDog) {
    return { error: "Credencial no encontrada." };
  }
  if (!target.serviceDog.inService) {
    return { error: "El perro ya está retirado del servicio." };
  }

  await db
    .update(petServiceDog)
    .set({ inService: false, updatedAt: new Date() })
    .where(eq(petServiceDog.id, target.serviceDog.id));

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/asistencia`);
  revalidatePath(`/p/${input.petPublicToken}`);
  return { ok: true };
}
