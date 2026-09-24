// Tattoo cross-check helper.
//
// Reads exclusively from the canonical `pet_identifications` table
// (kind='tattoo', status='active'). Tattoo codes legitimately collide across
// registries; we return the FIRST active match and require visual confirmation
// downstream (always say "posible coincidencia, verificá con foto" — never
// auto-merge).
//
// Migration 0082 completed the backfill — no active pet has a tattoo in the
// legacy pets.tattoo_* columns that is absent from pet_identifications.
// The legacy fallback (compliance PR 0 transition shim) has been removed in
// ARCH-Q now that canonical completeness is verified.

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, petIdentifications, pets, profiles } from "@/db";

export type TattooLookupResult = {
  pet: {
    id: string;
    publicToken: string;
    name: string;
    status: "active" | "lost" | "deceased";
    tattooLocation: string | null;
    tattooPhotoId: string | null;
    ownerUserId: string | null;
  };
  ownerFirstName: string | null;
} | null;

// Canonical normalizer — writers and readers converge here.
export function normalizeTattooCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export async function lookupByTattoo(rawCode: string): Promise<TattooLookupResult> {
  const normalized = normalizeTattooCode(rawCode);
  if (!normalized) return null;

  const [row] = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      petStatus: pets.status,
      tattooLocation: petIdentifications.tattooLocation,
      tattooPhotoId: petIdentifications.photoId,
      ownershipOwnerUserId: ownerships.ownerUserId,
      ownerDisplayName: profiles.displayName,
    })
    .from(petIdentifications)
    // Art. 16 (PO-4): same soft-delete filter as lookupByChip — an erased
    // pet's tattoo must read as never-registered on every cross-check.
    .innerJoin(pets, and(eq(pets.id, petIdentifications.petId), isNull(pets.deletedAt)))
    .leftJoin(
      ownerships,
      and(eq(ownerships.petId, pets.id), isNull(ownerships.endedAt), eq(ownerships.role, "owner")),
    )
    .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(
        eq(petIdentifications.kind, "tattoo"),
        eq(petIdentifications.code, normalized),
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
      tattooLocation: row.tattooLocation,
      tattooPhotoId: row.tattooPhotoId,
      ownerUserId: row.ownershipOwnerUserId ?? null,
    },
    ownerFirstName: row.ownerDisplayName ? row.ownerDisplayName.split(" ")[0] : null,
  };
}
