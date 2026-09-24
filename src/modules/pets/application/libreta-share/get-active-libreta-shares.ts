// Use-case: getActiveLibretaShares — narrow read for MergedShareSheet (ADR-14).
//
// Auth guard (requirePetAccess) is enforced by the caller (shim). This
// use-case receives the already-resolved petId so it never re-fetches or
// re-checks access.

import { and, eq, isNull } from "drizzle-orm";

import { type LibretaShareToken, db, libretaShareTokens } from "@/db";

export async function getActiveLibretaShares(petId: string): Promise<LibretaShareToken[]> {
  return db
    .select()
    .from(libretaShareTokens)
    .where(and(eq(libretaShareTokens.petId, petId), isNull(libretaShareTokens.revokedAt)));
}
