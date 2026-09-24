// Use-case: revokeTier2Public — strangler migration 50/61.
//
// Auth guard (requirePetAccess) is enforced by the caller (shim). This
// use-case receives the already-resolved pet object so it never re-fetches.

import { type Pet, db, pets } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function revokeTier2Public(pet: Pet, publicToken: string): Promise<void> {
  await db
    .update(pets)
    .set({ tier2PublicPermanent: false, tier2PublicEnabledUntil: null, updatedAt: new Date() })
    .where(eq(pets.id, pet.id));

  revalidatePath(`/mis-mascotas/${publicToken}`);
  revalidatePath(`/p/${publicToken}`);
}
