// The home-locality suggestion (PO, 2026-09-26; engram "Suggest the pet's home
// locality as a tap-to-pick chip, never prefilled").
//
// Where an OWNER is asked for a place about their own animal — marking it lost,
// updating where it was last seen, registering a second animal — the animal's
// REGISTERED locality is offered as one tap. This module answers only "which
// catalogue row is that", and only from the stored id:
//
//   · BY ID, NEVER BY NAME. `pets.locality_id` is the structural FK into
//     `ar_localities`; `pets.jurisdiction_locality` is display text. A pet whose
//     locality never resolved to a row has no id and gets NO suggestion — a
//     name looked up here would be a new name→row path, which is exactly what
//     lint:place-resolver forbids outside the resolver.
//   · NOTHING IS WRITTEN. The row goes to the client as a row the person may
//     pick; the write path resolves whatever the person sends, as it always has.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db, ownerships, pets } from "@/db";
import { type LocalitySearchResult, localityById } from "@/lib/infra/ar-localidades";
import { provinceByCode } from "@/lib/reference/ar-provincias";

/** A catalogue row, in the shape the pickers select. */
export type HomeLocality = LocalitySearchResult;

/** What a form needs to render the chip: the row, and whose home it is. */
export type HomeLocalitySuggestion = { locality: HomeLocality; petName: string };

/** The live catalogue row behind a stored `locality_id`; null when there is none. */
export async function homeLocalityRow(
  localityId: string | null | undefined,
): Promise<HomeLocality | null> {
  if (!localityId) return null;
  const row = await localityById(localityId);
  if (!row) return null;
  const province = provinceByCode(row.provinceCode);
  if (!province) return null;
  return { ...row, provinceName: province.name, matchKind: "exact" };
}

/** A pet's own suggestion — null when its locality never resolved to a row. */
export async function petHomeSuggestion(pet: {
  name: string;
  localityId: string | null;
}): Promise<HomeLocalitySuggestion | null> {
  const locality = await homeLocalityRow(pet.localityId);
  return locality ? { locality, petName: pet.name } : null;
}

/**
 * For the alta of a SECOND animal: the locality of the owner's most recently
 * adopted animal that has one. Titular ownerships only (a caretaker's or a
 * foster's animal does not say where THIS person lives), live pets only.
 */
export async function ownerLatestHomeSuggestion(
  userId: string,
): Promise<HomeLocalitySuggestion | null> {
  const [latest] = await db
    .select({ name: pets.name, localityId: pets.localityId })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
        isNull(pets.deletedAt),
        isNotNull(pets.localityId),
      ),
    )
    .orderBy(desc(ownerships.startedAt))
    .limit(1);
  return latest ? petHomeSuggestion(latest) : null;
}
