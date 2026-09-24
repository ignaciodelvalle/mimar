"use server";

// pet-onboarding.ts — "Primeros pasos" checklist actions.
//
// Auth guard (requirePetAccess) + revalidation live here (ADR 2026-07-18
// native-readiness, Decision 1: the application layer stays framework-free);
// business logic is delegated to
// src/modules/pets/application/profile/dismiss-first-step.ts.
//
// CRITICAL: Every runtime export in a "use server" file must be an async function.

import { requirePetAccess } from "@/lib/infra/pet-access";
import type { FirstStepKey } from "@/lib/projections/first-steps-checklist";
import { dismissFirstStep } from "@/src/modules/pets/application/profile/dismiss-first-step";
import { revalidatePath } from "next/cache";

export async function dismissFirstStepAction(
  publicToken: string,
  key: FirstStepKey,
): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) throw new Error(access.error);
  const wrote = await dismissFirstStep(access.pet.id, key);
  if (wrote) revalidatePath(`/mis-mascotas/${publicToken}`);
}
