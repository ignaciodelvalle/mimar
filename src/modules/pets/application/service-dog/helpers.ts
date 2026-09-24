// Shared helper: loadOwnedPetWithServiceDog
// Used by: upsert-service-dog, submit-verification-request, set-service-dog-visibility, retire-service-dog

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, petServiceDog, pets } from "@/db";

// Helper: only the active owner of a pet can manage the service-dog row.
// Returns the pet row + service_dog row (if any).
export async function loadOwnedPetWithServiceDog(
  userId: string,
  publicToken: string,
): Promise<{
  pet: typeof pets.$inferSelect;
  serviceDog: typeof petServiceDog.$inferSelect | null;
} | null> {
  const [row] = await db
    .select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [sd] = await db
    .select()
    .from(petServiceDog)
    .where(eq(petServiceDog.petId, row.pet.id))
    .limit(1);
  return { pet: row.pet, serviceDog: sd ?? null };
}
