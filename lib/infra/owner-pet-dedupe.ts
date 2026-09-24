// Soft same-owner pet dedupe (data-quality gate P2).
//
// Before an owner alta creates a pet, we check whether the caller ALREADY has
// an ACTIVE owned pet that looks like the same animal — same normalized name
// (case/accent/whitespace-insensitive) + same species + same sex. This is a
// non-blocking nudge: on a match the alta returns a confirmation prompt so the
// owner can open the existing pet or knowingly create a second one.
//
// Intentionally soft: two real pets can legitimately share a name/species/sex
// (littermates, "Negro" #1 and #2), so we never hard-block on this signal.

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, petEvents, pets } from "@/db";

export type OwnerDuplicateMatch = {
  publicToken: string;
  name: string;
  species: string;
  sex: "male" | "female" | "unknown";
};

/**
 * Normalize a pet name for comparison: lowercase, NFD-decompose + strip
 * combining marks (accent-insensitive), collapse internal whitespace, trim.
 * Same shape as the accent-folding normalizers used elsewhere in the codebase
 * (e.g. lib/infra/ar-localidades.ts, lib/domain/symptom-matcher.ts).
 */
export function normalizePetName(raw: string): string {
  return raw.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * Returns the caller's active owned pet that matches the candidate on
 * normalized name + species + sex, or null if none. Fetches the (typically
 * small) set of active ownerships for the user and compares in JS so the
 * accent-folding stays identical to the rest of the app without depending on
 * the Postgres `unaccent` extension.
 */
export async function findSameOwnerDuplicatePet(input: {
  ownerUserId: string;
  name: string;
  species: string;
  sex: "male" | "female" | "unknown";
  /**
   * The `Idempotency-Key` of the registration being attempted, when there is one.
   *
   * A PET THIS KEY ALREADY CREATED IS NOT A DUPLICATE OF ITSELF
   * (A2-alta-asentar-04). The native alta gives up on a request after 10 s and
   * offers a retry; on a slow connection the server commits anyway, so the
   * retry — carrying the SAME key, which is the whole point of the key — met
   * this scan first and was answered `duplicate_pet_suspected`: "Ya tenés
   * registrada una mascota llamada Pampa…", about the pet the phone had just
   * created. `registerPet`'s in-transaction replay would have answered 201 with
   * the original token, and never ran, because the refusal happened before it.
   * "Cancelar" then sent the person away believing nothing had been registered.
   *
   * Excluded HERE rather than by reordering the route, because the ordering is
   * not the bug: the scan is right to run early (a refused registration should
   * cost the cheapest possible work) and wrong only about this one pet.
   */
  excludeClientIdempotencyKey?: string | null;
}): Promise<OwnerDuplicateMatch | null> {
  const target = normalizePetName(input.name);
  if (!target) return null;

  const rows = await db
    .select({
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      sex: pets.sex,
      // The key the pet was REGISTERED with. `leftJoin` and not `innerJoin`: a
      // pet with no `pet_registered` row is debris invariant #3 forbids, and a
      // dedupe scan is not the place to start dropping animals over it.
      registrationKey: petEvents.clientIdempotencyKey,
    })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .leftJoin(
      petEvents,
      and(eq(petEvents.petId, pets.id), eq(petEvents.eventType, "pet_registered")),
    )
    .where(
      and(
        eq(ownerships.ownerUserId, input.ownerUserId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    );

  return selectDuplicateRow(rows, input);
}

/** One of the caller's active owned pets, as the scan above reads it. */
export type OwnerPetRow = {
  publicToken: string;
  name: string;
  species: string;
  sex: string;
  /** `client_idempotency_key` of the pet's `pet_registered` event, if any. */
  registrationKey: string | null;
};

/**
 * The MATCH RULE, separated from the query so it can be tested without a
 * database — the exclusion above is a behaviour, and a behaviour asserted only
 * by "the route passed the argument" is not asserted at all.
 */
export function selectDuplicateRow(
  rows: readonly OwnerPetRow[],
  criteria: {
    name: string;
    species: string;
    sex: "male" | "female" | "unknown";
    excludeClientIdempotencyKey?: string | null;
  },
): OwnerDuplicateMatch | null {
  const target = normalizePetName(criteria.name);
  if (!target) return null;
  const excluded = criteria.excludeClientIdempotencyKey?.trim() || null;

  for (const row of rows) {
    if (excluded !== null && row.registrationKey === excluded) continue;
    if (
      row.species === criteria.species &&
      row.sex === criteria.sex &&
      normalizePetName(row.name) === target
    ) {
      return {
        publicToken: row.publicToken,
        name: row.name,
        species: row.species,
        sex: row.sex as "male" | "female" | "unknown",
      };
    }
  }

  return null;
}
