// Use-case: correctPetSpecies — the FULL-LOCK species path (PO decision #40),
// extracted from `correctPetSpeciesAction` on 2026-09-10 so a second door could
// reach it.
//
// WHY THIS EXISTS AS A USE-CASE. Species is locked on the profile-edit path
// because it drives PPP/compliance; a genuine correction ran its whole
// transaction INLINE in src/modules/pets/actions.ts, and
// scripts/check-owner-surface-parity.ts reported it as `unjoined:` — an owner
// capability the fence could not even tie to a v1 route, because there was no
// application module for the two doors to meet at. Now there is: the web
// action and `POST /api/v1/pets/{token}/profile` (`correct_species`) both call
// this and nothing else decides what a correction does.
//
// WHAT A CORRECTION IS, and the invariant it keeps: a correction is a NEW EVENT,
// never an edit. `PetsRepository.correctSpecies` appends a `pet_profile_updated`
// carrying the species change (and the breed and PPP changes it drags along)
// BEFORE it moves the cached columns — the same shape the inline action had,
// preserved here verbatim. The columns are the cache; the event is the fact.
//
// WHAT TRAVELS WITH THE SPECIES, both decided here and by nobody else:
//   · THE BREED. A stored breed that does not resolve within the NEW species'
//     catalog is cleared in the same write (adversarial review 2026-08-14, F2):
//     left alone, the grandfather rule (breed-validation.ts, QA A5) would carry
//     a cross-species breed through every later edit, forever. The special
//     options ("Mixto / Cruza", "Pura raza no listada") resolve in every
//     species' catalog and survive.
//   · THE PPP FLAG. Re-resolved for the corrected species AND the possibly
//     cleared breed, against the animal's own jurisdiction — a non-dog clears
//     it. The resolver is a dependency so both doors hand in the SAME function
//     and a unit test can hand in a stub.
//
// THE SAME SPECIES IS A SUCCESS WITH `changed: false`, NOT A REFUSAL, and that
// is the replay rule this repo pays for: a correction's success invalidates its
// own precondition (the animal is now the species that was asked for), so a
// retried request that lost its response arrives at an animal that already IS
// what it asks and must answer the same way the first one did. "There is
// nothing to correct" is still true, and each door says it in its own voice —
// the web keeps its refusal sentence, the bearer door acks `changed: false`.
//
// AUTH IS THE CALLER'S JOB, as for every use-case in this module: the web door
// guards with `requireTitularAccess`, the bearer door with `isTitularHolder`
// over `resolvePetHolderAccess` — the same predicate, so the two cannot drift.

import { PET_SPECIES } from "@dim/contract/input";

import { resolveBreedForWrite } from "@/lib/domain/breed-validation";

import type { PetsRepository } from "../../infrastructure/pets-repository";

/**
 * The species vocabulary the credential accepts. The contract's own list, so
 * the wire schema (`z.enum(PET_SPECIES)`), the web form and this rule cannot
 * disagree about what a species is.
 */
export const CORRECTABLE_SPECIES: readonly string[] = PET_SPECIES;

/** The columns of the animal a correction reads. Structural — the row satisfies it. */
export type SpeciesCorrectionPet = {
  id: string;
  species: string;
  breed: string | null;
  estimatedWeightKg: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

type AuthorRole = "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";

export type SpeciesCorrectionAuthorship = {
  authorRole: AuthorRole;
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

export type CorrectPetSpeciesInput = {
  pet: SpeciesCorrectionPet;
  /** The species the animal SHOULD be. Validated here against `CORRECTABLE_SPECIES`. */
  newSpecies: string;
  actor: {
    userId: string;
    eventAuthorship: SpeciesCorrectionAuthorship;
  };
};

/** The PPP rule, as a function: (species, breed, weightKg, jurisdiction) → flag. */
export type PppResolver = (
  species: string,
  breed: string | null,
  estimatedWeightKg: number | null,
  jurisdiction: { country: string; province: string | null; locality: string | null },
) => Promise<boolean>;

export type CorrectPetSpeciesDeps = {
  repo: Pick<typeof PetsRepository, "correctSpecies">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  resolvePpp: PppResolver;
};

export type CorrectPetSpeciesFailureCode = "species_invalid" | "write_failed";

export type CorrectPetSpeciesResult =
  /** The animal already IS this species — a replay, or a no-op. Nothing written. */
  | { ok: true; changed: false; species: string }
  | {
      ok: true;
      changed: true;
      eventId: string;
      species: string;
      /** What the breed column holds after the write — `null` when it was cleared. */
      breed: string | null;
      /** `true` when the correction cleared a breed the new species' catalog does not carry. */
      breedCleared: boolean;
      potentiallyDangerousBreed: boolean;
    }
  | { ok: false; code: "species_invalid" }
  | { ok: false; code: "write_failed"; error: string };

/**
 * Parses the domain layer's `estimatedWeightKg: string | null` into the
 * `number | null` the PPP resolver expects. NaN-guards a malformed string down
 * to null (treated as "no weight data", same as omitted — never throws).
 */
function parseEstimatedWeightKg(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}

export async function correctPetSpecies(
  input: CorrectPetSpeciesInput,
  deps: CorrectPetSpeciesDeps,
): Promise<CorrectPetSpeciesResult> {
  const { pet, actor } = input;
  const newSpecies = input.newSpecies.trim();

  if (!CORRECTABLE_SPECIES.includes(newSpecies)) return { ok: false, code: "species_invalid" };

  // The replay / no-op arm — see the header. Decided BEFORE any I/O, on the row
  // the caller's guard already read.
  if (newSpecies === pet.species) return { ok: true, changed: false, species: newSpecies };

  const breedResolution = resolveBreedForWrite(newSpecies, pet.breed);
  const correctedBreed: string | null = breedResolution.ok ? pet.breed : null;

  const potentiallyDangerousBreed = await deps.resolvePpp(
    newSpecies,
    correctedBreed,
    parseEstimatedWeightKg(pet.estimatedWeightKg),
    {
      country: "AR",
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
    },
  );

  let eventId: string;
  try {
    ({ eventId } = await deps.transaction(async (tx) =>
      deps.repo.correctSpecies(
        {
          petId: pet.id,
          oldSpecies: pet.species,
          newSpecies,
          oldBreed: pet.breed,
          newBreed: correctedBreed,
          potentiallyDangerousBreed,
          userId: actor.userId,
          eventAuthorship: actor.eventAuthorship,
          now: new Date(),
        },
        tx as Parameters<typeof PetsRepository.correctSpecies>[1],
      ),
    ));
  } catch (err) {
    return {
      ok: false,
      code: "write_failed",
      error: err instanceof Error ? err.message : "error desconocido",
    };
  }

  return {
    ok: true,
    changed: true,
    eventId,
    species: newSpecies,
    breed: correctedBreed,
    breedCleared: pet.breed !== null && correctedBreed === null,
    potentiallyDangerousBreed,
  };
}
