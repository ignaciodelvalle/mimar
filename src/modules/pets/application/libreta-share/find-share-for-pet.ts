// Reader: findShareForPet — does this share row belong to this animal?
//
// WHY IT EXISTS AT ALL, when `revokeLibretaShareForUser` already reads the row.
// The web's revoke action is NOT nested under a pet: `revokeLibretaShareAction`
// takes a bare row id, and the writer looks it up by primary key with no pet
// predicate. That is fine for a control rendered inside one animal's sheet,
// where the id can only have come from that animal's list.
//
// `POST /api/v1/pets/{publicToken}/shares` is a different shape. The animal is
// in the PATH, and honouring a row id belonging to some other animal would make
// that segment a lie — an admin could revoke anybody's link through any pet's
// URL. So the endpoint checks membership first, and a foreign id answers exactly
// what a nonexistent one answers.
//
// It reads the REVOCATION STATE too, and that is the second reason this is a
// reader rather than an inline count: the endpoint reports whether a command
// actually changed anything, and "already revoked" is only knowable before the
// write. Measuring it beats re-deriving it.

import { and, eq } from "drizzle-orm";

import { db, libretaShareTokens } from "@/db";

export type ShareRowForPet = {
  id: string;
  /** `null` while the link still works. */
  revokedAt: Date | null;
};

export async function findShareForPet(
  shareId: string,
  petId: string,
): Promise<ShareRowForPet | null> {
  const [row] = await db
    .select({ id: libretaShareTokens.id, revokedAt: libretaShareTokens.revokedAt })
    .from(libretaShareTokens)
    .where(and(eq(libretaShareTokens.id, shareId), eq(libretaShareTokens.petId, petId)))
    .limit(1);
  return row ?? null;
}
