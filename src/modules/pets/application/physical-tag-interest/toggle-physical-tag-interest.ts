// Toggle the §4.20 physical-tag-interest placeholder for a pet/user pair.
//
// Three states the action handles:
//   - first toggle: INSERT a new row (cancelled_at NULL).
//   - second toggle on the active row: SET cancelled_at = now() (soft).
//   - third toggle on a cancelled row: CLEAR cancelled_at (re-interest).
//
// Ownership is enforced by the caller (shim) via requirePetAccess + owner-path
// check before this use-case is invoked.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, physicalTagInterest } from "@/db";

import type { TogglePhysicalTagInterestResult } from "./types";

export async function togglePhysicalTagInterest(
  userId: string,
  petId: string,
  petPublicToken: string,
): Promise<TogglePhysicalTagInterestResult> {
  const [existing] = await db
    .select({
      id: physicalTagInterest.id,
      cancelledAt: physicalTagInterest.cancelledAt,
    })
    .from(physicalTagInterest)
    .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)))
    .limit(1);

  let nextState: "interested" | "cancelled";
  if (!existing) {
    await db.insert(physicalTagInterest).values({ petId, userId });
    nextState = "interested";
  } else if (existing.cancelledAt) {
    await db
      .update(physicalTagInterest)
      .set({ cancelledAt: null })
      .where(eq(physicalTagInterest.id, existing.id));
    nextState = "interested";
  } else {
    await db
      .update(physicalTagInterest)
      .set({ cancelledAt: new Date() })
      .where(eq(physicalTagInterest.id, existing.id));
    nextState = "cancelled";
  }

  revalidatePath(`/mis-mascotas/${petPublicToken}`);
  return { ok: true, state: nextState };
}
