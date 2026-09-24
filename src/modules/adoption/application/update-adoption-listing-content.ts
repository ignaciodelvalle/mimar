// Use-case: update the adoption listing content (story, requirements, buckets, etc.).
//
// No domain-rule file for content validation — the logic is inline and
// mirrors the action's validation block. No events emitted; this is
// shelter-curated marketing copy.
//
// The caller (thin action) is responsible for:
//   - requireCapability("adoption.listing.manage")
//   - Parsing the raw form input

import {
  ADOPTION_AGE_BUCKETS,
  ADOPTION_ENERGY_LEVELS,
  ADOPTION_SIZE_ESTIMATES,
} from "../domain/types";
import type { ListingContentInput } from "../domain/types";
import type { AdoptionRepository } from "../infrastructure/adoption-repository";
import type { UseCaseResult } from "./set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STORY_LEN = 5000;
const MAX_REQUIREMENTS_LEN = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: { id: string; publicToken: string; verified: boolean };
};

type Deps = {
  repo: typeof AdoptionRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type UpdateListingContentInput = ListingContentInput & {
  petPublicToken: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function updateAdoptionListingContent(
  input: UpdateListingContentInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, actor } = deps;
  const { organization } = actor;

  // 1. Load pet.
  const petRow = await repo.findShelterPet(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 2. Validate enums.
  if (input.ageBucket && !(ADOPTION_AGE_BUCKETS as readonly string[]).includes(input.ageBucket)) {
    return { ok: false, error: "Edad inválida." };
  }
  if (
    input.sizeEstimate &&
    !(ADOPTION_SIZE_ESTIMATES as readonly string[]).includes(input.sizeEstimate)
  ) {
    return { ok: false, error: "Talle inválido." };
  }
  if (
    input.energyLevel &&
    !(ADOPTION_ENERGY_LEVELS as readonly string[]).includes(input.energyLevel)
  ) {
    return { ok: false, error: "Nivel de energía inválido." };
  }

  // 3. Validate fee.
  if (input.feeArs != null && input.feeArs < 0) {
    return { ok: false, error: "El aporte de adopción no puede ser negativo." };
  }

  // 4. Validate text length.
  if (input.story && input.story.length > MAX_STORY_LEN) {
    return { ok: false, error: `La historia no puede superar ${MAX_STORY_LEN} caracteres.` };
  }
  if (input.requirements && input.requirements.length > MAX_REQUIREMENTS_LEN) {
    return {
      ok: false,
      error: `Los requisitos no pueden superar ${MAX_REQUIREMENTS_LEN} caracteres.`,
    };
  }

  // 5. Persist (single-table write, no transaction needed).
  await repo.updateListingContent(
    {
      petId: petRow.id,
      story: input.story?.trim() || null,
      requirements: input.requirements?.trim() || null,
      ageBucket: input.ageBucket ?? null,
      sizeEstimate: input.sizeEstimate ?? null,
      energyLevel: input.energyLevel ?? null,
      goodWithKids: input.goodWithKids ?? null,
      goodWithDogs: input.goodWithDogs ?? null,
      goodWithCats: input.goodWithCats ?? null,
      needsYard: input.needsYard ?? null,
      feeArs: input.feeArs ?? null,
    },
    undefined, // no shared transaction
  );

  return { ok: true, notifications: [] };
}
