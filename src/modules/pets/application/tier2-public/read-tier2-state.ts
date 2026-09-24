// Reader: readTier2State — the two columns that decide what the public
// credential shows.
//
// WHY A READER AND NOT AN INLINE COMPARISON. `POST .../shares` reports whether a
// command actually CHANGED anything, and both Tier-2 writers are deliberately
// idempotent: `enableTier2Public` returns early when the animal is already
// permanently exposed, and treats a window ending within a minute of the
// requested one as a duplicate submit (`enable-tier2-public.ts:36,:54`).
//
// The endpoint could re-implement those two conditions to predict the outcome.
// It must not: a second copy of "within a minute" is exactly the drift the
// contract package exists to stop, and it would go wrong silently the day
// somebody tunes the window. So the endpoint MEASURES instead — it reads these
// columns before the call and again after, and compares. This module is that
// read, named once so both sides use the same projection.

import { and, eq, isNull } from "drizzle-orm";

import { db, pets } from "@/db";

export type Tier2State = {
  permanent: boolean;
  /** The bounded window's end. `null` when permanent, or when nothing is open. */
  until: Date | null;
};

/**
 * THE SOFT-DELETE FILTER IS NOT DECORATION HERE, even though the caller has
 * already resolved access.
 *
 * `POST /api/v1/pets/{token}/shares` reaches this only after
 * `resolvePetHolderAccess`, which is deletion-aware, so in practice the row is
 * known live by the time this runs. The filter stays for two reasons the PO-4
 * fence is right about (`__tests__/public-soft-delete-resolution.test.ts`): this
 * module is reachable from the `/api/v1` door, which that rule counts as public;
 * and "the caller checked already" is exactly the reasoning that leaves the NEXT
 * caller unguarded. An erased subject's animal has no Tier-2 state worth
 * reporting, so the filter is also just correct.
 */
export async function readTier2State(petId: string): Promise<Tier2State | null> {
  const [row] = await db
    .select({
      permanent: pets.tier2PublicPermanent,
      until: pets.tier2PublicEnabledUntil,
    })
    .from(pets)
    .where(and(eq(pets.id, petId), isNull(pets.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether two snapshots differ.
 *
 * A MISSING SNAPSHOT COUNTS AS DIFFERENT, deliberately. If either read came back
 * empty the endpoint cannot prove nothing happened, and "changed: false" is a
 * claim — reporting the write as effective is the honest direction to be wrong
 * in, because it sends the client to re-read rather than to trust a stale view.
 */
export function tier2StateDiffers(before: Tier2State | null, after: Tier2State | null): boolean {
  if (before === null || after === null) return true;
  if (before.permanent !== after.permanent) return true;
  return (before.until?.getTime() ?? null) !== (after.until?.getTime() ?? null);
}
