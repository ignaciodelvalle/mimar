// dismiss-first-step use-case — "Primeros pasos" onboarding checklist.
//
// Auth guard (requirePetAccess) is enforced by the caller (shim). This
// use-case receives the already-resolved petId so it never re-fetches.
//
// Appends a step key to pets.dismissed_first_steps (migration 0153). A UI
// preference, not a fact about the pet — no pet_profile_updated event, same
// posture as setPetDisclosurePrefs.
//
// Framework-free (ADR 2026-07-18 native-readiness, Decision 1): revalidation
// belongs in the actions layer, not here — the caller (app/actions/
// pet-onboarding.ts) revalidates when this returns `true`.

import { eq, sql } from "drizzle-orm";

import { db, pets } from "@/db";
import type { FirstStepKey } from "@/lib/projections/first-steps-checklist";

/**
 * Marks a "Primeros pasos" step as dismissed for one pet.
 *
 * Idempotent: dismissing an already-dismissed key is a no-op (no row write)
 * — array append uses `array_append`, guarded by the read-then-check below so
 * a double-submit can't grow duplicates.
 *
 * @param petId - The pet's internal id (resolved by the calling shim).
 * @param key   - Which onboarding step to dismiss.
 * @returns     `true` when a row was written (caller should revalidate).
 */
export async function dismissFirstStep(petId: string, key: FirstStepKey): Promise<boolean> {
  const [current] = await db
    .select({ dismissed: pets.dismissedFirstSteps })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);

  // Unknown pet → nothing to write (shim already validated access; this only
  // happens on a stale submit). Already dismissed → desired state already holds.
  if (!current || current.dismissed.includes(key)) return false;

  await db
    .update(pets)
    .set({
      dismissedFirstSteps: sql`array_append(${pets.dismissedFirstSteps}, ${key})`,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, petId));

  return true;
}
