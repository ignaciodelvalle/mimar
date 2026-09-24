// Microchip cross-check helper.
//
// Reads exclusively from the canonical `pet_identifications` table
// (kind='microchip_iso', status='active'). The unique partial index guarantees
// at most one active chip row per code, so there is always at most one match.
//
// Migration 0082 completed the backfill — no active pet has a chip in the
// legacy pets.microchip_id column that is absent from pet_identifications.
// The legacy fallback that existed here (compliance PR 0 transition shim) has
// been removed in ARCH-Q now that canonical completeness is verified.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, ownerships, petIdentifications, pets, profiles } from "@/db";

export type ChipLookupResult = {
  pet: {
    id: string;
    publicToken: string;
    name: string;
    status: "active" | "lost" | "deceased";
    photoUrl: string | null;
    ownerUserId: string | null;
  };
  ownerFirstName: string | null;
} | null;

// Pure DB lookup — no auth, no session. Callers gate capability.
// Reads from the canonical `pet_identifications` (kind='microchip_iso',
// status='active'). The chip_unique partial index guarantees at most one match.
export async function lookupByChip(microchipId: string): Promise<ChipLookupResult> {
  if (!microchipId) return null;

  const [row] = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      petStatus: pets.status,
      ownershipOwnerUserId: ownerships.ownerUserId,
      ownerDisplayName: profiles.displayName,
    })
    .from(petIdentifications)
    // The join carries the soft-delete filter (art. 16, PO-4): erasure leaves
    // the chip row `active` (migration 0207 has no statements over
    // pet_identifications) but the pet itself must answer like a chip that was
    // never registered — the same posture lookupTagBySerial takes for the
    // chapa. Filtering HERE closes every consumer at once (alta cross-checks,
    // claim, denuncia, org intake, CSV import): an erased pet's chip is
    // indistinguishable from an unknown one, so no caller can leak its name,
    // token, status or owner.
    .innerJoin(pets, and(eq(pets.id, petIdentifications.petId), isNull(pets.deletedAt)))
    .leftJoin(
      ownerships,
      and(eq(ownerships.petId, pets.id), isNull(ownerships.endedAt), eq(ownerships.role, "owner")),
    )
    .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(
        eq(petIdentifications.kind, "microchip_iso"),
        eq(petIdentifications.code, microchipId),
        eq(petIdentifications.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    pet: {
      id: row.petId,
      publicToken: row.petPublicToken,
      name: row.petName,
      status: row.petStatus as "active" | "lost" | "deceased",
      photoUrl: null,
      ownerUserId: row.ownershipOwnerUserId ?? null,
    },
    ownerFirstName: row.ownerDisplayName ? row.ownerDisplayName.split(" ")[0] : null,
  };
}

/**
 * Proof-of-knowledge check: does `attemptedCode` equal the pet's canonical
 * active microchip?
 *
 * This is the inverse of lookupByChip and it exists so that the chip-match
 * confirmation surfaces can gate on "the caller already knows this code"
 * WITHOUT ever handling the code themselves. The comparison happens inside the
 * SQL predicate and the projection is a constant — the canonical code is never
 * selected, so no caller of this function can leak it, deliberately or by
 * accident, and there is no string comparison in JS to time.
 *
 * Returns false for an empty attempt and for a pet with no active chip: a
 * uniform "no" that says nothing about which of the two it was.
 */
export async function attemptedChipMatchesPet(
  petId: string,
  attemptedCode: string,
): Promise<boolean> {
  const code = attemptedCode?.trim();
  if (!petId || !code) return false;

  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(petIdentifications)
    .where(
      and(
        eq(petIdentifications.petId, petId),
        eq(petIdentifications.kind, "microchip_iso"),
        eq(petIdentifications.status, "active"),
        eq(petIdentifications.code, code),
      ),
    )
    .limit(1);

  return row !== undefined;
}
