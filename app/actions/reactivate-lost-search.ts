"use server";

// reactivate-lost-search.ts — thin "use server" shim for the STALE
// LostCaseBlock CTA (pet-document-redesign ADR-18). Auth (owner-only) is
// enforced here via requirePetAccess before delegating to the use-case.

import { revalidatePath } from "next/cache";

import { requirePetAccess } from "@/lib/infra/pet-access";
import { reactivateLostSearch } from "@/src/modules/cases/application/reactivate-lost-search";

export async function reactivateLostSearchAction(publicToken: string): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) throw new Error(access.error);
  const { user, pet, accessPath } = access;

  if (accessPath !== "owner") {
    throw new Error("Solo el dueño puede reactivar la búsqueda.");
  }

  const result = await reactivateLostSearch({
    petId: pet.id,
    petPublicToken: publicToken,
    petStatus: pet.status,
    jurisdictionProvince: pet.jurisdictionProvince ?? null,
    jurisdictionLocality: pet.jurisdictionLocality ?? null,
    openedByUserId: user.id,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  revalidatePath(`/mis-mascotas/${publicToken}`);
}
