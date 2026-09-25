// Read: the animal's service-dog row, for the owner's own view of it.
//
// The SAME single-row read `AsistenciaPage` makes inline
// (`app/(app)/mis-mascotas/[publicToken]/asistencia/page.tsx`), lifted here so
// the bearer door (`GET /api/v1/pets/{token}/profile`, D3) reads it through a
// module instead of re-writing the query in a route. It carries NO access rule
// of its own — a caller decides who may see the row before calling it, the way
// the web page resolves the ownership first.

import { eq } from "drizzle-orm";

import { type PetServiceDog, db, petServiceDog } from "@/db";

export type ServiceDogDesignationRow = PetServiceDog;

export async function readServiceDogDesignation(
  petId: string,
): Promise<ServiceDogDesignationRow | null> {
  const [row] = await db
    .select()
    .from(petServiceDog)
    .where(eq(petServiceDog.petId, petId))
    .limit(1);
  return row ?? null;
}
