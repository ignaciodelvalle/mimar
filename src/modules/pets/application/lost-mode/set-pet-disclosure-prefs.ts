// set-pet-disclosure-prefs use-case (strangler migration 61/61).
//
// Auth guard (requirePetAccess) is enforced by the caller (shim). This
// use-case receives the already-resolved petId so it never re-fetches.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import type { DisclosurePrefs } from "@/components/pet-profile/LostDisclosureCard";
import { db, pets } from "@/db";

/**
 * Toggle a single disclosure pref on a pet's row.
 *
 * Idempotent by desired-state (projection-writes audit §6): setting a pref to
 * the value it already holds is a no-op — no row write, no updatedAt bump, no
 * revalidation. A double-submit therefore cannot flip-flop the pref.
 *
 * RETURNS WHETHER IT WROTE, and that is the WU-M addition. The no-op branch
 * always knew and the caller never got to; a web toggle that re-renders from the
 * revalidated page does not need to know, but `POST /api/v1/pets/{token}/lost`
 * answers `changed` and would otherwise have to guess or re-read. Same shape as
 * every other "the writer knew and dropped it at the boundary" fix in this
 * family.
 *
 * @param petId       - The pet's internal id (resolved by the calling shim).
 * @param publicToken - The pet's public token (for cache revalidation).
 * @param key         - Which preference to update.
 * @param next        - The new boolean value.
 * @returns `true` when the row was written, `false` when it already held `next`.
 */
export async function setPetDisclosurePrefs(
  petId: string,
  publicToken: string,
  key: keyof DisclosurePrefs,
  next: boolean,
): Promise<boolean> {
  const [current] = await db
    .select({ value: pets[key] })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);

  // Unknown pet → nothing to write (shim already validated access; this only
  // happens on a stale submit). Same value → desired state already holds.
  if (!current || current.value === next) return false;

  await db
    .update(pets)
    .set({ [key]: next, updatedAt: new Date() })
    .where(eq(pets.id, petId));

  revalidatePath(`/mis-mascotas/${publicToken}`);
  return true;
}
