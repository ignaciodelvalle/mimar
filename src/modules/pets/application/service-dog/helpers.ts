// Shared helper: loadOwnedPetWithServiceDog
// Used by: upsert-service-dog, submit-verification-request, set-service-dog-visibility, retire-service-dog

import { and, eq, isNull, ne } from "drizzle-orm";

import { db, ownerships, petServiceDog, pets } from "@/db";

// Helper: only the active owner of a pet can manage the service-dog row.
// Returns the pet row + service_dog row (if any).
//
// A DECEASED ANIMAL RESOLVES TO NOTHING, which every owner use-case already
// answers as a refusal. This is the single choke point all four go through
// (web actions and `POST /api/v1/pets/{token}/profile` alike), and without it a
// scripted client could file a live `service_dog_credential_verification`
// request for a dead dog into the authority's queue — the web hid the entry
// point, but hiding a door is not locking it.
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
        ne(pets.status, "deceased"),
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
